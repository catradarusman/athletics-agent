import cron from 'node-cron';
import {
  getAllActiveCommitments,
  getExpiredActiveCommitments,
  updateCommitmentStatus,
  recordPoolEvent,
  getWeeklyResolutionStats,
  getUnrecordedProofs,
  updateProofOnchainStatus,
  type Commitment,
} from '../db/queries.js';
import { castInChannel, getUserByFid } from './bot.js';
import * as replies from './replies.js';
import {
  resolveCommitmentOnchain,
  recordProofOnchain,
  getPoolBalance,
  getPublicClient,
  getFidHasActive,
  getFidActiveId,
  getCommitmentOnchain,
} from '../chain/index.js';
import { backfillCommitmentId } from '../db/queries.js';

const CHANNEL_ID = 'higher-athletics';
const SNAP_URL = (process.env.SNAP_URL ?? '').trim() || undefined;

// ─── Spam guard ───────────────────────────────────────────────────────────────
// Track the last time we sent a reminder for each commitment (by DB id).
// In-memory is sufficient — reminders are best-effort and reset on restart.

const lastReminderAt = new Map<number, number>(); // commitmentId → epoch ms
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1_000; // 24 hours
const URGENT_WINDOW_MS     = 48 * 60 * 60 * 1_000; // 48 hours

// Resolution retry tracking — prevent infinite retries on permanently failing txs
const resolutionRetries = new Map<number, number>(); // commitmentId → retry count
const MAX_RESOLUTION_RETRIES = 10;

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

function hoursLeft(c: Commitment): number {
  return Math.max(0, Math.ceil((c.end_time.getTime() - Date.now()) / 3_600_000));
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
        text = `@${username} ${replies.reminderUrgent({ needed, hours: hoursLeft(c) })}`;
      } else {
        text = `@${username} ${replies.reminderGentle({ current: c.verified_proofs, total: c.required_proofs, daysLeft: daysLeft(c) })}`;
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
      // M13: Check retry count — skip permanently failing commitments
      const retries = resolutionRetries.get(c.id) ?? 0;
      if (retries >= MAX_RESOLUTION_RETRIES) {
        console.error(`[cron:resolution] commitment ${c.id} exceeded ${MAX_RESOLUTION_RETRIES} retries — skipping`);
        continue;
      }

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
          const onchainId  = await getFidActiveId(BigInt(c.fid));
          commitmentId     = Number(onchainId);
          const onchain    = await getCommitmentOnchain(onchainId);
          await backfillCommitmentId(c.id, commitmentId, onchain.startTime, onchain.endTime);
          console.log(`[cron:resolution] backfilled commitment_id=${commitmentId} start=${onchain.startTime.toISOString()} end=${onchain.endTime.toISOString()} for db id=${c.id}`);
        } catch (err) {
          console.error(`[cron:resolution] backfill failed for commitment ${c.id}:`, err);
          resolutionRetries.set(c.id, retries + 1);
          continue;
        }
      }

      // C3 fix: Reconcile unrecorded proofs before resolution
      try {
        const unrecorded = await getUnrecordedProofs(c.id);
        for (const proof of unrecorded) {
          try {
            const txHash = await recordProofOnchain(BigInt(commitmentId));
            const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash });
            if (receipt.status === 'success') {
              await updateProofOnchainStatus(proof.id, txHash);
              console.log(`[cron:resolution] reconciled proof ${proof.id} onchain`);
            } else {
              console.error(`[cron:resolution] proof ${proof.id} onchain tx reverted`);
            }
          } catch (err) {
            console.error(`[cron:resolution] failed to reconcile proof ${proof.id}:`, err);
            // Continue — try to reconcile as many as possible
          }
        }
      } catch (err) {
        console.error(`[cron:resolution] failed to fetch unrecorded proofs for commitment ${c.id}:`, err);
      }

      // Settle onchain
      const txHash = await resolveCommitmentOnchain(BigInt(commitmentId));
      console.log(`[cron:resolution] submitted resolve tx=${txHash} for commitment ${c.id}`);

      // Wait for mining before updating DB — prevents DB/chain state divergence
      const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        console.error(`[cron:resolution] tx ${txHash} reverted for commitment ${c.id} — will retry next run`);
        resolutionRetries.set(c.id, retries + 1);
        continue;
      }

      // H11 fix: Read actual resolved status from chain, not DB
      let passed: boolean;
      try {
        const onchainState = await getCommitmentOnchain(BigInt(commitmentId));
        passed = onchainState.status === 'Passed';
      } catch {
        // Fallback to DB if chain read fails
        passed = c.verified_proofs >= c.required_proofs;
        console.warn(`[cron:resolution] chain read failed for commitment ${c.id}, using DB state`);
      }

      const outcome = passed ? 'passed' : 'failed';
      const now     = new Date();

      // Update DB only after confirmed onchain
      await updateCommitmentStatus(c.id, outcome, now);

      // Log pool event for failures (pledge forfeited to pool)
      if (!passed) {
        await recordPoolEvent({
          event_type:    'failure',
          amount:        c.pledge_amount,
          commitment_id: c.id,
          tx_hash:       txHash,
        });
      }

      // Notify on Farcaster using Higher voice
      const user     = await getUserByFid(c.fid);
      const username = user?.username ?? `fid:${c.fid}`;

      let text: string;
      if (passed) {
        text = `@${username} ${replies.commitmentPassed({
          current:  c.verified_proofs,
          total:    c.required_proofs,
          payout:   Math.round(c.pledge_amount * 0.9),
          snapUrl:  SNAP_URL,
        })}`;
      } else {
        text = `@${username} ${replies.commitmentFailed({
          current: c.verified_proofs,
          total:   c.required_proofs,
          amount:  c.pledge_amount,
        })}`;
      }

      await castInChannel(text, CHANNEL_ID, SNAP_URL && passed ? [SNAP_URL] : undefined);
      console.log(`[cron:resolution] notified fid=${c.fid} status=${status}`);

      // Clean up retry counter on success
      resolutionRetries.delete(c.id);
    } catch (err) {
      const retries = resolutionRetries.get(c.id) ?? 0;
      resolutionRetries.set(c.id, retries + 1);
      console.error(`[cron:resolution] error processing commitment ${c.id} (retry ${retries + 1}):`, err);
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

    const stats       = await getWeeklyResolutionStats(weekSince);
    const poolBalance = Number(poolBalanceWei / BigInt(10 ** 18));

    const text = replies.weeklyUpdate({
      poolBalance,
      active: activeCommitments.length,
      passed: stats.passed,
      failed: stats.failed,
    });

    await castInChannel(text, CHANNEL_ID);
    console.log('[cron:weekly] pool update cast');
  } catch (err) {
    console.error('[cron:weekly] error:', err);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerCronJobs(): void {
  // Reminder — disabled (too noisy)
  // cron.schedule('0 */6 * * *', runReminderCron, { timezone: 'UTC' });

  // Resolution — every hour
  cron.schedule('0 * * * *', runResolutionCron, { timezone: 'UTC' });

  // Weekly pool update — disabled (too noisy)
  // cron.schedule('0 12 * * 1', runWeeklyPoolUpdate, { timezone: 'UTC' });

  console.log('[cron] registered: resolution (1h)');
}
