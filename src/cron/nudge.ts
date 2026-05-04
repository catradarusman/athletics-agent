import cron from 'node-cron';
import { query } from '../db/index.js';
import { castReply, castInChannel, getUserByFid } from '../agent/bot.js';
import { reminderGentle, reminderUrgent } from '../agent/replies.js';

interface NudgeableCommitment {
  id:              number;
  fid:             number;
  verified_proofs: number;
  required_proofs: number;
  end_time:        Date;
}

async function getNudgeableCommitments(): Promise<NudgeableCommitment[]> {
  const now     = new Date();
  const in72h   = new Date(now.getTime() + 72 * 3_600_000);
  const cooloff = new Date(now.getTime() - 12 * 3_600_000);
  const result  = await query<Record<string, unknown>>(
    `SELECT id, fid, verified_proofs, required_proofs, end_time
     FROM commitments
     WHERE status = 'paid'
       AND end_time > $1
       AND end_time <= $2
       AND verified_proofs < required_proofs
       AND (nudge_sent_at IS NULL OR nudge_sent_at < $3)`,
    [now, in72h, cooloff],
  );
  return result.rows as unknown as NudgeableCommitment[];
}

async function getLastProofHash(commitmentId: number): Promise<string | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT cast_hash FROM proofs
     WHERE commitment_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [commitmentId],
  );
  return result.rows[0] ? (result.rows[0] as { cast_hash: string }).cast_hash : null;
}

async function markNudgeSent(commitmentId: number): Promise<void> {
  await query(
    `UPDATE commitments SET nudge_sent_at = NOW() WHERE id = $1`,
    [commitmentId],
  );
}

async function runNudgeCron(): Promise<void> {
  console.log('[cron:nudge] running');

  let commitments: NudgeableCommitment[];
  try {
    commitments = await getNudgeableCommitments();
  } catch (err) {
    console.error('[cron:nudge] failed to fetch commitments:', err);
    return;
  }

  for (const c of commitments) {
    try {
      const hoursRemaining  = Math.max(0, Math.ceil((c.end_time.getTime() - Date.now()) / 3_600_000));
      const proofsRemaining = c.required_proofs - c.verified_proofs;

      const user     = await getUserByFid(c.fid);
      const username = user?.username ?? `fid:${c.fid}`;

      let text: string;
      if (hoursRemaining < 24) {
        text = `@${username} ${reminderUrgent({ needed: proofsRemaining, hours: hoursRemaining })}`;
      } else {
        text = `@${username} ${reminderGentle({
          current:  c.verified_proofs,
          total:    c.required_proofs,
          daysLeft: Math.ceil(hoursRemaining / 24),
        })}`;
      }

      const lastHash = await getLastProofHash(c.id);
      if (lastHash) {
        await castReply(lastHash, text);
      } else {
        await castInChannel(text, 'higher-athletics');
      }

      await markNudgeSent(c.id);
      console.log(`[cron:nudge] nudged fid=${c.fid} commitment=${c.id} hours_left=${hoursRemaining}`);
    } catch (err) {
      console.error(`[cron:nudge] error processing commitment ${c.id}:`, err);
    }
  }
}

export function registerNudgeCron(): void {
  cron.schedule('0 */6 * * *', runNudgeCron, { timezone: 'UTC' });
  console.log('[cron] registered: nudge (6h)');
}
