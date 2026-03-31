import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { CastWithInteractions } from '@neynar/nodejs-sdk/build/api/models/cast-with-interactions.js';
import type { WebhookCastCreated } from '@neynar/nodejs-sdk/build/types/webhooks.js';
import { castReply } from './bot.js';
import { validateProof } from '../ai/validator.js';
import {
  getActiveCommitmentByFid,
  getProofsByCommitmentId,
  recordProof,
  createCommitment,
  backfillCommitmentId,
  type PledgeTier,
} from '../db/queries.js';
import {
  recordProofOnchain,
  getPoolBalance,
  createCommitmentTxData,
  getFidHasActive,
  getFidActiveId,
} from '../chain/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_ID = 'higher-athletics';
const BOT_USERNAME = (process.env.BOT_USERNAME ?? 'higherathletics').toLowerCase();

// ─── Templates ────────────────────────────────────────────────────────────────

interface Template {
  durationDays:   number;
  requiredProofs: number;
  description:    string;
}

const TEMPLATES: Record<string, Template> = {
  'sprint':         { durationDays: 7,  requiredProofs: 7,  description: 'daily for 7 days' },
  'monthly-grind':  { durationDays: 30, requiredProofs: 12, description: '3x/week for 30 days' },
  'builders-block': { durationDays: 14, requiredProofs: 5,  description: '5 of 14 days' },
  'beast-mode':     { durationDays: 30, requiredProofs: 30, description: 'daily for 30 days' },
};

// ─── Tiers ────────────────────────────────────────────────────────────────────

interface Tier {
  name:      PledgeTier;
  amount:    number;   // whole HIGHER tokens
  index:     bigint;
}

const TIERS: Record<string, Tier> = {
  'starter':  { name: 'Starter',  amount: 1_000,  index: 0n },
  'standard': { name: 'Standard', amount: 5_000,  index: 1n },
  'serious':  { name: 'Serious',  amount: 10_000, index: 2n },
  'allin':    { name: 'All-in',   amount: 25_000, index: 3n },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isBotMentioned(cast: CastWithInteractions): boolean {
  if (cast.mentioned_profiles?.some(u => u.username.toLowerCase() === BOT_USERNAME)) return true;
  return cast.text.toLowerCase().includes(`@${BOT_USERNAME}`);
}

function isChannelCast(cast: CastWithInteractions): boolean {
  if (cast.channel?.id === CHANNEL_ID) return true;
  const url = cast.root_parent_url ?? cast.parent_url ?? '';
  return url.includes(CHANNEL_ID);
}

function hasImage(cast: CastWithInteractions): boolean {
  return cast.embeds?.some(e => {
    const url = (e as { url?: string }).url ?? '';
    return /\.(png|jpe?g|gif|webp)($|\?)/i.test(url) ||
           url.includes('imagedelivery') ||
           url.includes('i.imgur') ||
           url.includes('cdn.warpcast');
  }) ?? false;
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleCommit(cast: CastWithInteractions, words: string[]): Promise<void> {
  const fid = cast.author.fid;

  // Check for existing active commitment
  const existing = await getActiveCommitmentByFid(fid);
  if (existing) {
    await castReply(
      cast.hash,
      `You already have an active commitment (${existing.template}). Finish it before starting a new one! 💪`,
    );
    return;
  }

  // Parse: @bot commit <template> <tier>
  const botIdx = words.findIndex(w => w.toLowerCase().startsWith(`@${BOT_USERNAME}`));
  const args   = words.slice(botIdx + 2); // skip "@bot" and "commit"

  const templateKey = args[0]?.toLowerCase();
  const tierKey     = args[1]?.toLowerCase();

  const template = templateKey ? TEMPLATES[templateKey] : undefined;
  const tier     = tierKey     ? TIERS[tierKey]         : undefined;

  if (!template || !tier) {
    const templateList = Object.keys(TEMPLATES).join(' | ');
    const tierList     = Object.keys(TIERS).join(' | ');
    await castReply(
      cast.hash,
      `To commit, reply with:\n@${BOT_USERNAME} commit <template> <tier>\n\nTemplates: ${templateList}\nTiers: ${tierList}`,
    );
    return;
  }

  // Create DB commitment record (commitment_id backfilled once onchain tx confirms)
  const walletAddress =
    (cast.author as unknown as { verified_addresses?: { eth_addresses?: string[] } })
      .verified_addresses?.eth_addresses?.[0] ??
    (cast.author as unknown as { custody_address?: string }).custody_address ??
    '0x';
  const now     = new Date();
  const endDate = new Date(now.getTime() + template.durationDays * 86_400_000);
  try {
    await createCommitment({
      fid,
      wallet_address:  walletAddress,
      template:        templateKey!,
      pledge_tier:     tier.name as PledgeTier,
      pledge_amount:   tier.amount,
      start_time:      now,
      end_time:        endDate,
      required_proofs: template.requiredProofs,
    });
  } catch (err) {
    console.error('[webhook] failed to create DB commitment for fid', fid, err);
    // Continue — user still gets the tx instructions; DB record can be reconciled
  }

  const contractAddress = process.env.CONTRACT_ADDRESS ?? '(contract not configured)';
  const txData = (() => {
    try {
      return createCommitmentTxData(
        BigInt(fid),
        tier.index,
        BigInt(template.durationDays),
        BigInt(template.requiredProofs),
      );
    } catch {
      return null;
    }
  })();

  const reply = [
    `🏆 Ready to commit to "${templateKey}" at the ${tier.name} tier (${tier.amount.toLocaleString()} HIGHER)?`,
    ``,
    `📋 Your commitment: ${template.description}, ${template.requiredProofs} proofs required`,
    `💰 Pledge: ${tier.amount.toLocaleString()} HIGHER tokens`,
    ``,
    `To lock it in, call createCommitment() on the contract:`,
    `📄 ${contractAddress}`,
    ...(txData ? [`Args: fid=${fid}, tier=${tier.index}, days=${template.durationDays}, proofs=${template.requiredProofs}`] : []),
    ``,
    `Once your tx confirms, start posting proof casts here and I'll validate them! 🎯`,
  ].join('\n');

  await castReply(cast.hash, reply);
}

async function handleStatus(cast: CastWithInteractions): Promise<void> {
  const fid        = cast.author.fid;
  const commitment = await getActiveCommitmentByFid(fid);

  if (!commitment) {
    await castReply(
      cast.hash,
      `No active commitment found for you. Start one with:\n@${BOT_USERNAME} commit <template> <tier>`,
    );
    return;
  }

  const now        = new Date();
  const daysLeft   = Math.max(0, Math.ceil((commitment.end_time.getTime() - now.getTime()) / 86_400_000));
  const pct        = Math.round((commitment.verified_proofs / commitment.required_proofs) * 100);
  const bar        = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));

  await castReply(
    cast.hash,
    [
      `📊 ${cast.author.username}'s commitment status:`,
      `Goal: ${commitment.template} (${commitment.pledge_tier} tier, ${commitment.pledge_amount.toLocaleString()} HIGHER)`,
      `Progress: ${bar} ${commitment.verified_proofs}/${commitment.required_proofs} proofs (${pct}%)`,
      `Time left: ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
    ].join('\n'),
  );
}

async function handlePool(_cast: CastWithInteractions): Promise<void> {
  let poolSize = '?';
  try {
    const raw = await getPoolBalance();
    // Convert from 18-decimal wei to whole tokens
    poolSize = (Number(raw) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 });
  } catch {
    // Contract not deployed yet or network error — reply with placeholder
  }

  await castReply(
    _cast.hash,
    [
      `🏊 Higher Athletics Prize Pool`,
      ``,
      `Current pool: ${poolSize} HIGHER`,
      ``,
      `Winners receive their pledge back + a share of forfeited pledges from athletes who didn't complete their commitment. 🏆`,
    ].join('\n'),
  );
}

async function handleProof(cast: CastWithInteractions): Promise<void> {
  const fid        = cast.author.fid;
  let commitment   = await getActiveCommitmentByFid(fid);

  if (!commitment) return; // silently ignore — no active commitment

  // Backfill commitment_id from chain if the user's createCommitment tx has confirmed
  if (commitment.commitment_id === null) {
    try {
      const hasActive = await getFidHasActive(BigInt(fid));
      if (!hasActive) return; // onchain commitment not yet created — ignore proof
      const onchainId = await getFidActiveId(BigInt(fid));
      await backfillCommitmentId(commitment.id, Number(onchainId));
      commitment = { ...commitment, commitment_id: Number(onchainId) };
    } catch (err) {
      console.error('[webhook] commitment_id backfill failed for fid', fid, err);
      return;
    }
  }

  // Fetch previous proof summaries for dedup context
  const previousProofs   = await getProofsByCommitmentId(commitment.id);
  const previousSummaries = previousProofs
    .filter(p => p.ai_valid && p.ai_summary)
    .map(p => p.ai_summary as string);

  const result = await validateProof(
    commitment,
    cast.text,
    hasImage(cast),
    previousSummaries,
  );

  if (!result.valid) {
    await castReply(
      cast.hash,
      `❌ Proof not accepted: ${result.reason}\n\nPost a cast with more detail — distance, time, reps, or a screenshot from your tracking app.`,
    );
    return;
  }

  // Record in DB
  await recordProof({
    commitment_id: commitment.id,
    cast_hash:     cast.hash,
    fid,
    cast_text:     cast.text,
    has_image:     hasImage(cast),
    ai_valid:      true,
    ai_reason:     result.reason,
    ai_summary:    result.summary ?? null,
  });

  // Record onchain (best-effort — don't block the reply on tx confirmation)
  const newCount = commitment.verified_proofs + 1;
  if (commitment.commitment_id !== null) {
    recordProofOnchain(BigInt(commitment.commitment_id)).catch(err => {
      console.error(`[webhook] onchain recordProof failed for commitment ${commitment.commitment_id}:`, err);
    });
  }

  const remaining = commitment.required_proofs - newCount;
  const isComplete = remaining <= 0;

  await castReply(
    cast.hash,
    isComplete
      ? [
          `✅ Proof accepted! ${result.reason}`,
          ``,
          `🎉 You've completed your ${commitment.template} commitment! ${newCount}/${commitment.required_proofs} proofs recorded.`,
          ``,
          `Call claim() on the contract to get your pledge back + prize share! 🏆`,
        ].join('\n')
      : [
          `✅ Proof accepted! ${result.reason}`,
          `${newCount}/${commitment.required_proofs} proofs recorded — ${remaining} to go. Keep it up! 💪`,
        ].join('\n'),
  );
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const webhookRouter = Router();

webhookRouter.post('/webhook', async (req: Request, res: Response) => {
  // Verify Neynar webhook signature (HMAC-SHA512 over raw body)
  const secret = process.env.WEBHOOK_SECRET;
  const rawBody = req.body as Buffer;
  if (secret) {
    const sig = req.headers['x-neynar-signature'] as string | undefined;
    if (!sig || !Buffer.isBuffer(rawBody)) {
      return res.status(401).send('missing signature');
    }
    const hmac = crypto.createHmac('sha512', secret);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(digest, 'hex'))) {
        return res.status(401).send('invalid signature');
      }
    } catch {
      return res.status(401).send('invalid signature');
    }
  }

  // Acknowledge quickly so Neynar doesn't retry
  res.sendStatus(200);

  const payload = JSON.parse(rawBody.toString('utf8')) as WebhookCastCreated;
  if (payload.type !== 'cast.created') return;

  // The webhook payload includes enriched cast fields even though the SDK types
  // it as Cast — treat it as CastWithInteractions.
  const cast = payload.data as unknown as CastWithInteractions;

  if (!isChannelCast(cast)) return;

  const text  = cast.text ?? '';
  const words = text.trim().split(/\s+/);
  const lower = text.toLowerCase();

  try {
    if (isBotMentioned(cast)) {
      if (lower.includes('commit')) {
        await handleCommit(cast, words);
      } else if (lower.includes('status')) {
        await handleStatus(cast);
      } else if (lower.includes('pool')) {
        await handlePool(cast);
      } else {
        await castReply(
          cast.hash,
          `Hey! I can help with:\n• @${BOT_USERNAME} commit <template> <tier>\n• @${BOT_USERNAME} status\n• @${BOT_USERNAME} pool`,
        );
      }
    } else {
      await handleProof(cast);
    }
  } catch (err) {
    console.error('[webhook] handler error:', err);
  }
});
