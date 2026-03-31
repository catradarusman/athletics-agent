import cron from 'node-cron';
import {
  getAllActiveCommitments,
  getExpiredActiveCommitments,
  updateCommitmentStatus,
  recordPoolEvent,
  getWeeklyResolutionStats,
  type Commitment,
} from '../db/queries.js';
import { castInChannel, getUserByFid } from './bot.js';
import {
  resolveCommitmentOnchain,
  getPoolBalance,
  getPublicClient,
  getFidHasActive,
  getFidActiveId,
} from '../chain/index.js';
import { backfillCommitmentId } from '../db/queries.js';

const CHANNEL_ID = 'higher-athletics';

// ─── Spam guard ───────────────────────────────────────────────────────────────
// Track the last time we sent a reminder for each commitment (by DB id).
// In-memory is sufficient — reminders are best-effort and reset on restart.

const lastReminderAt = new Map<number, number>(); // commitmentId → epoch ms
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1_000; // 24 hours
const URGENT_WINDOW_MS     = 48 * 60 * 60 * 1_000; // 48 hours

function canRemind(commitmentId: number): boolean {
  const last = lastReminderAt.get(commitmentId);
  return last === undefined || Date.now() - last >= REMINDER_COOLDOWN_MS;
}

function markReminded(commitmentId: number): void {
  lastReminderAt.set(commitmentId, Date.now());
}

// ─── Progress helpers ─────────────────────────────────────────────────────────

function timeFraction(c: Commitment): number {
  const total   = c.end_time.getTime() - c.start_time.getTime();
  const elapsed = Date.now()           - c.start_time.getTime();
  return total > 0 ? Math.min(elapsed / total, 1) : 1;
}

function proofFraction(c: Commitment): number {
  return c.required_proofs > 0 ? c.verified_proofs / c.required_proofs : 1;
}

function daysLeft(c: Commitment): number {
  return Math.max(0, Math.ceil((c.end_time.getTime() - Date.now()) / 86_400_000));
}

// ─── 1. REMINDER CRON — every 6 hours ────────────────────────────────────────

async function runReminderCron(): Promise<void> {
  console.log('[cron:reminder] running');

  let commitments: Commitment[];
  try {
    commitments = await getAllActiveCommitments();
  } catch (err) {
    console.error('[cron:reminder] failed to fetch commitments:', err);
    return;
  }

  for (const c of commitments) {
    try {
      if (!canRemind(c.id)) continue;

      const tf  = timeFraction(c);
      const pf  = proofFraction(c);
      const msLeft = c.end_time.getTime() - Date.now();

      // Determine if a reminder is warranted
      const behindSchedule = tf >= 0.1 && pf < tf * 0.8;
      const urgentWindow   = msLeft > 0 && msLeft <= URGENT_WINDOW_MS && c.verified_proofs < c.required_proofs;

      if (!behindSchedule && !urgentWindow) continue;

      const user = await getUserByFid(c.fid);
      const username = user?.username ?? `fid:${c.fid}`;

      let text: string;
      if (urgentWindow) {
        const needed = c.required_proofs - c.verified_proofs;
        text = `@${username} ${needed} more proof${needed === 1 ? '' : 's'} needed. 48 hours.`;
      } else {
        text = `@${username} ${c.verified_proofs}/${c.required_proofs} proofs. ${daysLeft(c)} day${daysLeft(c) === 1 ? '' : 's'} left.`;
      }

      await castInChannel(text, CHANNEL_ID);
      markReminded(c.id);
      console.log(`[cron:reminder] reminded fid=${c.fid} commitment=${c.id}`);
    } catch (err) {
      console.error(`[cron:reminder] error processing commitment ${c.id}:`, err);
    }
  }
}

// ─── 2. RESOLUTION CRON — every hour ─────────────────────────────────────────

async function runResolutionCron(): Promise<void> {
  console.log('[cron:resolution] running');

  let expired: Commitment[];
  try {
    expired = await getExpiredActiveCommitments();
  } catch (err) {
    console.error('[cron:resolution] failed to fetch expired commitments:', err);
    return;
  }

  for (const c of expired) {
    try {
      let commitmentId = c.commitment_id;

      // Backfill commitment_id from chain if missing
      if (commitmentId === null) {
        try {
          const hasActive = await getFidHasActive(BigInt(c.fid));
          if (!hasActive) {
            // User never called createCommitment — orphaned DB record; clean it up
            console.warn(`[cron:resolution] commitment ${c.id} fid=${c.fid} has no onchain commitment — marking failed`);
            await updateCommitmentStatus(c.id, 'failed', new Date());
            continue;
          }
          const onchainId = await getFidActiveId(BigInt(c.fid));
          commitmentId = Number(onchainId);
          await backfillCommitmentId(c.id, commitmentId);
          console.log(`[cron:resolution] backfilled commitment_id=${commitmentId} for db id=${c.id}`);
        } catch (err) {
          console.error(`[cron:resolution] backfill failed for commitment ${c.id}:`, err);
          continue;
        }
      }

      // Settle onchain
      const txHash = await resolveCommitmentOnchain(BigInt(commitmentId));
      console.log(`[cron:resolution] submitted resolve tx=${txHash} for commitment ${c.id}`);

      // Wait for mining before updating DB — prevents DB/chain state divergence
      const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        console.error(`[cron:resolution] tx ${txHash} reverted for commitment ${c.id} — will retry next run`);
        continue;
      }

      const passed   = c.verified_proofs >= c.required_proofs;
      const status   = passed ? 'passed' : 'failed';
      const now      = new Date();

      // Update DB only after confirmed onchain
      await updateCommitmentStatus(c.id, status, now);

      // Log pool event for failures (pledge forfeited to pool)
      if (!passed) {
        await recordPoolEvent({
          event_type:    'failure',
          amount:        c.pledge_amount,
          commitment_id: c.id,
          tx_hash:       txHash,
        });
      }

      // Notify on Farcaster
      const user     = await getUserByFid(c.fid);
      const username = user?.username ?? `fid:${c.fid}`;

      let text: string;
      if (passed) {
        text = `@${username} ${c.verified_proofs}/${c.required_proofs}. commitment complete. claim your $HIGHER.`;
      } else {
        text = `@${username} commitment ended. ${c.verified_proofs}/${c.required_proofs}. pledge to the pool.`;
      }

      await castInChannel(text, CHANNEL_ID);
      console.log(`[cron:resolution] notified fid=${c.fid} status=${status}`);
    } catch (err) {
      console.error(`[cron:resolution] error processing commitment ${c.id}:`, err);
    }
  }
}

// ─── 3. WEEKLY POOL UPDATE — every Monday at 12:00 UTC ───────────────────────

async function runWeeklyPoolUpdate(): Promise<void> {
  console.log('[cron:weekly] running');

  try {
    const [poolBalanceWei, activeCommitments, weekSince] = await Promise.all([
      getPoolBalance(),
      getAllActiveCommitments(),
      Promise.resolve(new Date(Date.now() - 7 * 86_400_000)),
    ]);

    const stats  = await getWeeklyResolutionStats(weekSince);
    const amount = Number(poolBalanceWei / BigInt(10 ** 18));

    const text = `pool: ${amount.toLocaleString()} $HIGHER. ${activeCommitments.length} active. ${stats.passed} completed. ${stats.failed} failed this week.`;

    await castInChannel(text, CHANNEL_ID);
    console.log('[cron:weekly] pool update cast');
  } catch (err) {
    console.error('[cron:weekly] error:', err);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerCronJobs(): void {
  // Reminder — every 6 hours
  cron.schedule('0 */6 * * *', runReminderCron, { timezone: 'UTC' });

  // Resolution — every hour
  cron.schedule('0 * * * *', runResolutionCron, { timezone: 'UTC' });

  // Weekly pool update — Monday 12:00 UTC
  cron.schedule('0 12 * * 1', runWeeklyPoolUpdate, { timezone: 'UTC' });

  console.log('[cron] registered: reminder (6h), resolution (1h), weekly (Mon 12:00 UTC)');
}
