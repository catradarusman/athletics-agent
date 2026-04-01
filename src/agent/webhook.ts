import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { CastWithInteractions } from '@neynar/nodejs-sdk/build/api/models/cast-with-interactions.js';
import type { WebhookCastCreated } from '@neynar/nodejs-sdk/build/types/webhooks.js';
import Anthropic from '@anthropic-ai/sdk';
import { castReply, getUserByFid } from './bot.js';
import { parseCommitment } from '../ai/parser.js';
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
const BOT_FID = Number(process.env.BOT_FID ?? 0);
const MIN_NEYNAR_USER_SCORE = Number(process.env.MIN_NEYNAR_USER_SCORE ?? 0.5);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

// fid → timestamp of last conversational reply (rate limiting)
const conversationCooldowns = new Map<number, number>();
const CONVERSATION_COOLDOWN_MS = 60_000;

// cast_hash → true: dedup across two webhooks firing for the same cast
const processedHashes = new Map<string, number>();
const HASH_TTL_MS = 30_000;

// ─── Pledge constants ─────────────────────────────────────────────────────────
// Single fixed pledge amount: 5,000 $HIGHER (contract PLEDGE_TIERS[1]).
// No tier selection — all commitments use the same stake.

const PLEDGE_AMOUNT     = 5_000;  // whole HIGHER tokens
const PLEDGE_TIER_INDEX = 1n;     // contract PLEDGE_TIERS[1] = 5k HIGHER

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

function isReplyToBot(cast: CastWithInteractions): boolean {
  return BOT_FID !== 0 && cast.parent_author?.fid === BOT_FID;
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

  // Check for existing active or pending commitment
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

  // Extract the goal text: everything after "@bot commit"
  const botIdx   = words.findIndex(w => w.toLowerCase().startsWith(`@${BOT_USERNAME}`));
  const goalText = words.slice(botIdx + 2).join(' ').trim(); // skip "@bot" and "commit"

  if (!goalText) {
    await castReply(cast.hash, replies.noActiveCommitment());
    return;
  }

  // Parse commitment intent with Claude
  const parsed = await parseCommitment(goalText);
  if (!parsed.ok) {
    await castReply(cast.hash, parsed.error);
    return;
  }

  const { description, durationDays, requiredProofs } = parsed.data;

  // Create DB record as pending_onchain — tokens not locked until user signs the tx
  const now     = new Date();
  const endDate = new Date(now.getTime() + durationDays * 86_400_000);
  try {
    await createCommitment({
      fid,
      wallet_address:  walletAddress,
      template:        description,
      pledge_tier:     'Standard',
      pledge_amount:   PLEDGE_AMOUNT,
      start_time:      now,
      end_time:        endDate,
      required_proofs: requiredProofs,
      status:          'pending_onchain',
    });
  } catch (err) {
    console.error('[webhook] failed to create DB commitment for fid', fid, err);
  }

  const contractAddress = process.env.CONTRACT_ADDRESS ?? '(contract not configured)';
  const tokenAddress    = process.env.HIGHER_TOKEN_ADDRESS ?? '(token not configured)';
  const amountWei       = BigInt(PLEDGE_AMOUNT) * BigInt(10 ** 18);

  const txData = (() => {
    try {
      return createCommitmentTxData(
        BigInt(fid),
        PLEDGE_TIER_INDEX,
        BigInt(durationDays),
        BigInt(requiredProofs),
      );
    } catch {
      return null;
    }
  })();

  // First deadline = end of first week
  const firstDeadline = new Date(now.getTime() + 7 * 86_400_000);
  const deadlineStr   = `${firstDeadline.toISOString().split('T')[0]} UTC`;

  await castReply(
    cast.hash,
    [
      replies.commitmentCreated({
        description,
        durationDays,
        requiredProofs,
        amount:        PLEDGE_AMOUNT,
        firstDeadline: deadlineStr,
      }),
      ``,
      `to lock your pledge onchain (two steps):`,
      `1. approve $HIGHER: call approve(${contractAddress}, ${amountWei}) on ${tokenAddress}`,
      `2. call createCommitment on ${contractAddress}:`,
      ...(txData ? [`   ${txData.data}`] : [`   (contract not configured)`]),
      `pledge is only locked once this tx confirms`,
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
- how the commitment bot works (pledging, proofs, payouts)
- command: @higherathletics commit [your goal] — any exercise counts (running, cycling, walking, swimming, gym, etc.)
- examples: "commit cycling every day for 2 weeks", "commit run 5k three times a week for a month"
- fixed pledge: 5,000 $HIGHER per commitment. no tiers.
- duration: 7–60 days. frequency: at least 1 proof/week, at most 1/day.
- payout: pledge minus 10% fee plus bonus from the prize pool
- bonus = min(pledge × 50%, pool × 2%)
- proofs: cast workout evidence in the channel. photos, tracking app screenshots, specific details required. generic statements don't count.
- one active commitment per person at a time

What you do:
- answer questions about how the bot works
- clarify commitment status if the user has one
- explain proof requirements
- point people to the right command if they seem lost
- keep it brief. 1-3 lines max. you're a bot, not a friend.
- keep responses under 300 characters total. one cast only.

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
      max_tokens: 100,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: cast.text }],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      console.error(`[webhook] unexpected content type from Claude: ${content.type}`);
      return;
    }

    const reply = content.text.slice(0, 320);
    console.log(`[webhook] Claude reply for fid=${fid}: "${reply.slice(0, 80)}"`);
    conversationCooldowns.set(fid, Date.now());
    await castReply(cast.hash, reply);
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error('[webhook] handleConversation Claude API error', {
        fid,
        status: err.status,
        message: err.message,
        name: err.name,
        requestId: err.request_id,
      });
      if (err.status === 529 || err.status === 503) {
        await castReply(cast.hash, replies.overloaded());
      }
    } else {
      console.error('[webhook] handleConversation unexpected error for fid', fid, err);
    }
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

if (BOT_FID === 0) {
  console.warn('[webhook] WARNING: BOT_FID not set — self-filter disabled, bot may reply to its own casts and loop');
}

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

  // Ignore the bot's own casts to prevent feedback loops
  if (BOT_FID !== 0 && cast.author.fid === BOT_FID) return;

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

      const botIdx = words.findIndex(w => w.toLowerCase().startsWith(`@${BOT_USERNAME}`));
      const commandWord = botIdx >= 0 ? (words[botIdx + 1] ?? '').toLowerCase() : '';

      if (commandWord === 'commit') {
        await handleCommit(cast, words);
      } else if (commandWord === 'status') {
        await handleStatus(cast);
      } else if (commandWord === 'pool') {
        await handlePool(cast);
      } else if (commandWord === 'leaderboard') {
        await handleLeaderboard(cast);
      } else {
        await handleConversation(cast);
      }
      return;
    }

    if (isReplyToBot(cast) && isRelatedToChannel(cast)) {
      await handleConversation(cast);
      return;
    }

    if (!isChannelCast(cast)) return;
    await handleProof(cast);
  } catch (err) {
    console.error('[webhook] handler error:', err);
  }
});
