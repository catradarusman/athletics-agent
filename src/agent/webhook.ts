import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { CastWithInteractions } from '@neynar/nodejs-sdk/build/api/models/cast-with-interactions.js';
import type { WebhookCastCreated } from '@neynar/nodejs-sdk/build/types/webhooks.js';
import Anthropic from '@anthropic-ai/sdk';
import { castReply, getUserByFid } from './bot.js';
import { validateProof } from '../ai/validator.js';
import * as replies from './replies.js';
import {
  getActiveCommitmentByFid,
  getProofsByCommitmentId,
  recordProof,
  createCommitment,
  backfillCommitmentId,
  updateProofOnchainStatus,
  getLeaderboard,
  getAllActiveCommitments,
  type PledgeTier,
} from '../db/queries.js';
import {
  recordProofOnchain,
  getPoolBalance,
  createCommitmentTxData,
  getFidHasActive,
  getFidActiveId,
  getPublicClient,
} from '../chain/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_ID = 'higher-athletics';
const BOT_USERNAME = (process.env.BOT_USERNAME ?? 'higherathletics').toLowerCase();
const MIN_NEYNAR_USER_SCORE = Number(process.env.MIN_NEYNAR_USER_SCORE ?? 0.5);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// fid → timestamp of last conversational reply (rate limiting)
const conversationCooldowns = new Map<number, number>();
const CONVERSATION_COOLDOWN_MS = 60_000;

// cast_hash → true: dedup across two webhooks firing for the same cast
const processedHashes = new Map<string, number>();
const HASH_TTL_MS = 30_000;

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

function isRelatedToChannel(cast: CastWithInteractions): boolean {
  if (cast.channel?.id === CHANNEL_ID) return true;
  const rootUrl = cast.root_parent_url ?? '';
  if (rootUrl.includes(CHANNEL_ID)) return true;
  const parentUrl = cast.parent_url ?? '';
  if (parentUrl.includes(CHANNEL_ID)) return true;
  return false;
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

function daysLeft(endTime: Date): number {
  return Math.max(0, Math.ceil((endTime.getTime() - Date.now()) / 86_400_000));
}

function getWalletAddress(cast: CastWithInteractions): string | null {
  const addr =
    (cast.author as unknown as { verified_addresses?: { eth_addresses?: string[] } })
      .verified_addresses?.eth_addresses?.[0] ??
    (cast.author as unknown as { custody_address?: string }).custody_address;
  if (!addr || addr === '0x' || addr.length < 10) return null;
  return addr;
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleCommit(cast: CastWithInteractions, words: string[]): Promise<void> {
  const fid = cast.author.fid;

  // Check Neynar User Score for sybil protection
  try {
    const user = await getUserByFid(fid);
    const score = (user as unknown as { experimental?: { neynar_user_score?: number } })
      ?.experimental?.neynar_user_score ?? 0;
    if (score < MIN_NEYNAR_USER_SCORE) {
      await castReply(
        cast.hash,
        `account score too low to commit. build your farcaster presence first`,
      );
      return;
    }
  } catch (err) {
    console.error('[webhook] user score check failed for fid', fid, err);
    // Continue — don't block on score fetch failure
  }

  // Check for existing active commitment
  const existing = await getActiveCommitmentByFid(fid);
  if (existing) {
    await castReply(
      cast.hash,
      `already have an active commitment (${existing.template}). finish it first`,
    );
    return;
  }

  // Check wallet
  const walletAddress = getWalletAddress(cast);
  if (!walletAddress) {
    await castReply(
      cast.hash,
      `no wallet found on your farcaster account. connect a wallet first`,
    );
    return;
  }

  // Parse: @bot commit <template> <tier>
  // Also supports: @bot commit custom <days> <proofs> <tier>
  const botIdx = words.findIndex(w => w.toLowerCase().startsWith(`@${BOT_USERNAME}`));
  const args   = words.slice(botIdx + 2); // skip "@bot" and "commit"

  const templateKey = args[0]?.toLowerCase();
  const tierKey     = args[args.length - 1]?.toLowerCase(); // tier is always last

  let template: Template | undefined;
  let tier: Tier | undefined;

  if (templateKey === 'custom') {
    // Custom: @bot commit custom <days> <proofs> <tier>
    const days   = parseInt(args[1], 10);
    const proofs = parseInt(args[2], 10);
    tier = tierKey ? TIERS[tierKey] : undefined;

    if (!tier || isNaN(days) || isNaN(proofs) || days < 7 || days > 60 || proofs < Math.ceil(days / 7) || proofs > days) {
      await castReply(
        cast.hash,
        [
          `custom format: @${BOT_USERNAME} commit custom <days> <proofs> <tier>`,
          `days: 7-60. proofs: at least 1/week, at most 1/day`,
          `tiers: ${Object.keys(TIERS).join(' | ')}`,
        ].join('\n'),
      );
      return;
    }

    template = { durationDays: days, requiredProofs: proofs, description: `${proofs}x over ${days} days` };
  } else {
    template = templateKey ? TEMPLATES[templateKey] : undefined;
    tier     = tierKey     ? TIERS[tierKey]         : undefined;
  }

  if (!template || !tier) {
    await castReply(cast.hash, replies.noActiveCommitment());
    return;
  }

  const resolvedTemplateKey = templateKey === 'custom' ? `custom-${template.durationDays}d` : templateKey!;

  // Create DB commitment record (commitment_id backfilled once onchain tx confirms)
  const now     = new Date();
  const endDate = new Date(now.getTime() + template.durationDays * 86_400_000);
  try {
    await createCommitment({
      fid,
      wallet_address:  walletAddress,
      template:        resolvedTemplateKey,
      pledge_tier:     tier.name as PledgeTier,
      pledge_amount:   tier.amount,
      start_time:      now,
      end_time:        endDate,
      required_proofs: template.requiredProofs,
    });
  } catch (err) {
    console.error('[webhook] failed to create DB commitment for fid', fid, err);
  }

  const contractAddress = process.env.CONTRACT_ADDRESS ?? '(contract not configured)';
  const txData = (() => {
    try {
      return createCommitmentTxData(
        BigInt(fid),
        tier!.index,
        BigInt(template!.durationDays),
        BigInt(template!.requiredProofs),
      );
    } catch {
      return null;
    }
  })();

  // Calculate first deadline for the Higher voice reply
  const firstDeadline = new Date(now.getTime() + 7 * 86_400_000); // first week
  const deadlineStr = `${firstDeadline.toISOString().split('T')[0]} UTC`;

  await castReply(
    cast.hash,
    [
      replies.commitmentCreated({
        template:       resolvedTemplateKey,
        duration:       template.durationDays,
        requiredProofs: template.requiredProofs,
        amount:         tier.amount,
        firstDeadline:  deadlineStr,
      }),
      ``,
      `contract: ${contractAddress}`,
      ...(txData ? [`args: fid=${fid}, tier=${tier.index}, days=${template.durationDays}, proofs=${template.requiredProofs}`] : []),
    ].join('\n'),
  );
}

async function handleStatus(cast: CastWithInteractions): Promise<void> {
  const fid        = cast.author.fid;
  const commitment = await getActiveCommitmentByFid(fid);

  if (!commitment) {
    await castReply(cast.hash, replies.noActiveCommitment());
    return;
  }

  const dl      = daysLeft(commitment.end_time);
  const onTrack = commitment.required_proofs > 0
    ? (commitment.verified_proofs / commitment.required_proofs) >= ((Date.now() - commitment.start_time.getTime()) / (commitment.end_time.getTime() - commitment.start_time.getTime())) * 0.8
    : true;

  await castReply(
    cast.hash,
    replies.status({
      current:  commitment.verified_proofs,
      total:    commitment.required_proofs,
      daysLeft: dl,
      amount:   commitment.pledge_amount,
      onTrack,
    }),
  );
}

async function handlePool(cast: CastWithInteractions): Promise<void> {
  let poolBalance = 0;
  try {
    const raw = await getPoolBalance();
    poolBalance = Number(raw / BigInt(10 ** 18));
  } catch {
    // Contract not deployed yet or network error
  }

  let activeCount = 0;
  try {
    const active = await getAllActiveCommitments();
    activeCount = active.length;
  } catch {
    // DB error — show 0
  }

  await castReply(
    cast.hash,
    replies.poolInfo({ poolBalance, activeCount }),
  );
}

async function handleLeaderboard(cast: CastWithInteractions): Promise<void> {
  try {
    const leaders = await getLeaderboard(10);
    if (leaders.length === 0) {
      await castReply(cast.hash, `no completed commitments yet. be the first`);
      return;
    }

    const lines = await Promise.all(
      leaders.map(async (entry, i) => {
        const user = await getUserByFid(entry.fid).catch(() => null);
        const name = user?.username ?? `fid:${entry.fid}`;
        return `${i + 1}. @${name} — ${entry.completed} completed`;
      }),
    );

    await castReply(cast.hash, lines.join('\n'));
  } catch (err) {
    console.error('[webhook] leaderboard error:', err);
    await castReply(cast.hash, `leaderboard unavailable right now`);
  }
}

async function handleProof(cast: CastWithInteractions): Promise<void> {
  const fid        = cast.author.fid;
  let commitment   = await getActiveCommitmentByFid(fid);

  if (!commitment) return; // silently ignore — no active commitment

  // Backfill commitment_id from chain if the user's createCommitment tx has confirmed
  if (commitment.commitment_id === null) {
    try {
      const hasActive = await getFidHasActive(BigInt(fid));
      if (!hasActive) {
        // C1 fix: tell user instead of silently ignoring
        await castReply(
          cast.hash,
          `proof received. waiting for your commitment tx to confirm onchain. repost after it confirms`,
        );
        return;
      }
      const onchainId = await getFidActiveId(BigInt(fid));
      await backfillCommitmentId(commitment.id, Number(onchainId));
      commitment = { ...commitment, commitment_id: Number(onchainId) };
    } catch (err) {
      console.error('[webhook] commitment_id backfill failed for fid', fid, err);
      await castReply(
        cast.hash,
        `proof received but couldn't verify your onchain commitment. try again shortly`,
      );
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

  // H6: If validation error (Claude down), don't reject — tell user we're retrying
  if (!result.valid && result.reason === 'validation error') {
    // Record proof with ai_valid=null (pending) for retry by cron
    try {
      await recordProof({
        commitment_id: commitment.id,
        cast_hash:     cast.hash,
        fid,
        cast_text:     cast.text,
        has_image:     hasImage(cast),
        ai_valid:      null,
        ai_reason:     null,
        ai_summary:    null,
      });
    } catch {
      // Duplicate cast_hash or other DB error — ignore
    }
    await castReply(cast.hash, `proof received, validating. we'll count it once confirmed`);
    return;
  }

  if (!result.valid) {
    await castReply(cast.hash, replies.proofInvalid());
    return;
  }

  // Record in DB (atomic: insert proof + increment verified_proofs)
  let proof;
  try {
    proof = await recordProof({
      commitment_id: commitment.id,
      cast_hash:     cast.hash,
      fid,
      cast_text:     cast.text,
      has_image:     hasImage(cast),
      ai_valid:      true,
      ai_reason:     result.reason,
      ai_summary:    result.summary ?? null,
    });
  } catch (err: unknown) {
    // Duplicate cast_hash → no-op
    if ((err as { code?: string }).code === '23505') return;
    throw err;
  }

  // C2 fix: Record onchain and track success/failure
  const newCount = commitment.verified_proofs + 1;
  if (commitment.commitment_id !== null) {
    recordProofOnchain(BigInt(commitment.commitment_id))
      .then(async (txHash) => {
        // Wait for confirmation then update DB
        try {
          const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash });
          if (receipt.status === 'success') {
            await updateProofOnchainStatus(proof.id, txHash);
          } else {
            console.error(`[webhook] onchain recordProof tx reverted for proof ${proof.id}`);
          }
        } catch (err) {
          console.error(`[webhook] onchain recordProof receipt failed for proof ${proof.id}:`, err);
        }
      })
      .catch(err => {
        console.error(`[webhook] onchain recordProof failed for proof ${proof.id}:`, err);
      });
  }

  const remaining = commitment.required_proofs - newCount;
  const isComplete = remaining <= 0;
  const dl = daysLeft(commitment.end_time);

  if (isComplete) {
    await castReply(
      cast.hash,
      replies.commitmentPassed({
        current: newCount,
        total:   commitment.required_proofs,
        payout:  Math.round(commitment.pledge_amount * 0.9), // approximate — actual bonus depends on pool
      }),
    );
  } else {
    await castReply(
      cast.hash,
      replies.proofValid({ current: newCount, total: commitment.required_proofs, daysLeft: dl }),
    );
  }
}

async function handleConversation(cast: CastWithInteractions): Promise<void> {
  const fid = cast.author.fid;
  console.log(`[webhook] handleConversation fid=${fid}`);

  // Rate limit: one conversational reply per FID per 60 seconds
  const lastReply = conversationCooldowns.get(fid);
  if (lastReply !== undefined && Date.now() - lastReply < CONVERSATION_COOLDOWN_MS) {
    console.log(`[webhook] conversation cooldown for fid=${fid}`);
    await castReply(cast.hash, replies.conversationCooldown());
    return;
  }

  const commitment = await getActiveCommitmentByFid(fid);

  let userContext: string;
  if (commitment) {
    const dl = daysLeft(commitment.end_time);
    userContext = `User context: active commitment "${commitment.template}", ${commitment.verified_proofs}/${commitment.required_proofs} proofs, ${dl} days remaining, ${commitment.pledge_amount} $HIGHER pledged.`;
  } else {
    userContext = `User context: no active commitment.`;
  }

  const systemPrompt = `You are the Higher Athletics bot on Farcaster. You live in the /higher-athletics channel.

Voice rules — these are non-negotiable:
- all lowercase. always.
- no periods on the last line of your response
- short sentences. no filler words. no adverbs.
- you count. you don't motivate. you don't cheer.
- last line carries the weight
- never say "let's go", "you got this", "keep grinding", "proud of you" or any motivational language
- never give financial advice about $HIGHER token price or trading
- never speak on behalf of the Higher network or make promises about the protocol

What you know:
- how the commitment bot works (templates, tiers, pledging, proofs, payouts)
- templates: sprint (7d/7), monthly-grind (30d/12), builders-block (14d/5), beast-mode (30d/30), custom (7-60d)
- tiers: starter (1k), standard (5k), serious (10k), allin (25k $HIGHER)
- payout: pledge minus 10% fee plus bonus from the prize pool
- bonus = min(pledge × 50%, pool × 2%)
- proofs: cast workout evidence in the channel. photos, screenshots, specific details required. generic statements don't count.
- one active commitment per person at a time

What you do:
- answer questions about how the bot works
- clarify commitment status if the user has one
- explain proof requirements
- point people to the right command if they seem lost
- keep it brief. 1-3 lines max. you're a bot, not a friend.

What you never do:
- motivate or encourage
- give opinions on fitness routines
- discuss token price or investment
- make up information you don't have
- pretend to be human

${userContext}`;

  try {
    console.log(`[webhook] calling Claude API for fid=${fid}`);
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 280,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: cast.text }],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      console.error(`[webhook] unexpected content type from Claude: ${content.type}`);
      return;
    }

    console.log(`[webhook] Claude reply for fid=${fid}: "${content.text.slice(0, 80)}"`);
    conversationCooldowns.set(fid, Date.now());
    await castReply(cast.hash, content.text);
  } catch (err) {
    console.error('[webhook] handleConversation Claude API error for fid', fid, err);
    // Silent failure — no fallback reply
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const webhookRouter = Router();

webhookRouter.post('/webhook', async (req: Request, res: Response) => {
  // Verify Neynar webhook signature (HMAC-SHA512 over raw body)
  // Supports two secrets: WEBHOOK_SECRET (channel webhook) and WEBHOOK_SECRET_2 (mentions webhook)
  const secrets = [process.env.WEBHOOK_SECRET, process.env.WEBHOOK_SECRET_2].filter(Boolean) as string[];
  const rawBody = req.body as Buffer;
  if (secrets.length > 0) {
    const sig = req.headers['x-neynar-signature'] as string | undefined;
    if (!sig || !Buffer.isBuffer(rawBody)) {
      return res.status(401).send('missing signature');
    }
    const verified = secrets.some(secret => {
      try {
        const hmac = crypto.createHmac('sha512', secret);
        hmac.update(rawBody);
        const digest = hmac.digest('hex');
        return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(digest, 'hex'));
      } catch {
        return false;
      }
    });
    if (!verified) {
      return res.status(401).send('invalid signature');
    }
  } else {
    // H7: Warn loudly if no webhook secret
    console.warn('[webhook] WARNING: WEBHOOK_SECRET not set — all webhooks accepted without verification');
  }

  // Acknowledge quickly so Neynar doesn't retry
  res.sendStatus(200);

  const payload = JSON.parse(rawBody.toString('utf8')) as WebhookCastCreated;
  if (payload.type !== 'cast.created') return;

  // The webhook payload includes enriched cast fields even though the SDK types
  // it as Cast — treat it as CastWithInteractions.
  const cast = payload.data as unknown as CastWithInteractions;

  // Dedup: two webhooks (channel + mentions) can fire for the same cast
  const now = Date.now();
  if (processedHashes.has(cast.hash)) {
    console.log(`[webhook] skipping duplicate cast ${cast.hash}`);
    return;
  }
  processedHashes.set(cast.hash, now);
  // Prune old entries to prevent memory growth
  for (const [hash, ts] of processedHashes) {
    if (now - ts > HASH_TTL_MS) processedHashes.delete(hash);
  }

  const text  = cast.text ?? '';
  const words = text.trim().split(/\s+/);
  const lower = text.toLowerCase();

  console.log(`[webhook] cast ${cast.hash} fid=${cast.author.fid} channel=${cast.channel?.id ?? 'none'} root=${cast.root_parent_url ?? 'none'} mentioned=${isBotMentioned(cast)} text="${text.slice(0, 80)}"`);

  try {
    if (isBotMentioned(cast)) {
      if (!isRelatedToChannel(cast)) {
        console.log(`[webhook] ignoring mention outside higher-athletics`);
        return;
      }

      if (lower.includes('commit')) {
        await handleCommit(cast, words);
      } else if (lower.includes('status')) {
        await handleStatus(cast);
      } else if (lower.includes('pool')) {
        await handlePool(cast);
      } else if (lower.includes('leaderboard')) {
        await handleLeaderboard(cast);
      } else {
        await handleConversation(cast);
      }
      return;
    }

    if (!isChannelCast(cast)) return;
    await handleProof(cast);
  } catch (err) {
    console.error('[webhook] handler error:', err);
  }
});
