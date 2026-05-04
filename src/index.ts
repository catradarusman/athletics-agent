import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { initDb, query } from './db/index.js';
import { webhookRouter } from './agent/webhook.js';
import { registerCronJobs } from './agent/cron.js';
import { registerNudgeCron } from './cron/nudge.js';
import {
  getLatestCommitmentByFid,
  getActiveCommitmentByFid,
  createCommitment,
  countActiveCommitments,
  getProofsByCommitmentId,
  type PledgeTier,
} from './db/queries.js';
import { getUserByFid, neynar } from './agent/bot.js';

const PORT = Number(process.env.PORT ?? 3000);
const SNAP_API_SECRET = process.env.SNAP_API_SECRET ?? '';

function verifySnapSecret(req: Request, res: Response): boolean {
  if (!SNAP_API_SECRET) return true; // not configured → allow (dev mode)
  if (req.headers['x-snap-secret'] !== SNAP_API_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

async function main() {
  // H7+M10: Enforce WEBHOOK_SECRET in production
  if (!process.env.WEBHOOK_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('WEBHOOK_SECRET is required in production — refusing to start without webhook verification');
    }
    console.warn('[boot] WARNING: WEBHOOK_SECRET not set — webhooks will be accepted without signature verification');
  }

  await initDb();
  console.log('[boot] database connected');

  const app = express();
  // Raw body for webhook signature verification — must come before express.json()
  app.use('/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(webhookRouter);

  // CORS for snap mini app cross-origin requests; security is provided by x-snap-secret
  app.use('/api', (req: Request, res: Response, next: () => void) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-snap-secret');
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ─── Snap API ──────────────────────────────────────────────────────────────

  function toSnapStatus(c: { status: string; outcome: string | null }): string {
    switch (c.status) {
      case 'created':   return 'pending_onchain';
      case 'paid':      return 'active';
      case 'end':       return c.outcome === 'passed' ? 'passed' : 'failed';
      case 'claimed':   return 'claimed';
      default:          return 'none'; // 'cancelled' or unknown
    }
  }

  /**
   * GET /api/commitment/:fid
   * Return the latest active/passed/failed commitment for a FID.
   * Used by the snap to show status and enable the claim flow.
   */
  app.get('/api/commitment/:fid', async (req: Request, res: Response) => {
    if (!verifySnapSecret(req, res)) return;
    const fid = Number(req.params.fid);
    if (!fid || isNaN(fid)) return void res.json({ status: 'none' });
    try {
      const commitment = await getLatestCommitmentByFid(fid);
      if (!commitment) return void res.json({ status: 'none' });
      const snapStatus = toSnapStatus(commitment);
      if (snapStatus === 'none') return void res.json({ status: 'none' });
      res.json({
        status:          snapStatus,
        id:              commitment.id,
        commitment_id:   commitment.commitment_id,
        template:        commitment.template,
        verified_proofs: commitment.verified_proofs,
        required_proofs: commitment.required_proofs,
        pledge_amount:   commitment.pledge_amount,
        start_time:      commitment.start_time.toISOString(),
        end_time:        commitment.end_time.toISOString(),
        pledge_tier:     commitment.pledge_tier,
      });
    } catch (err) {
      console.error('[api] GET /api/commitment/:fid error:', err);
      res.status(500).json({ status: 'none' });
    }
  });

  /**
   * POST /api/commitment/register
   * Called by the signing mini app after the user connects their wallet.
   * Creates a 'created' DB record before the user signs the tx.
   * Idempotent: silently succeeds if a pending/active commitment already exists.
   */
  app.post('/api/commitment/register', async (req: Request, res: Response) => {
    if (!verifySnapSecret(req, res)) return;
    const {
      fid, walletAddress, description,
      durationDays, requiredProofs, tierName, tierIndex, pledgeAmount,
    } = req.body as {
      fid: number; walletAddress: string; description: string;
      durationDays: number; requiredProofs: number;
      tierName: string; tierIndex: number; pledgeAmount: number;
    };

    if (!fid || !walletAddress || !description || !durationDays || !requiredProofs) {
      return void res.status(400).json({ error: 'missing required fields' });
    }

    try {
      // Check if already has active/pending commitment (idempotent)
      const existing = await getActiveCommitmentByFid(fid);
      if (existing) {
        return void res.json({ ok: true, id: existing.id, existing: true });
      }

      const now     = new Date();
      const endDate = new Date(now.getTime() + durationDays * 86_400_000);

      const commitment = await createCommitment({
        fid,
        wallet_address:  walletAddress,
        template:        description,
        pledge_tier:     tierName as PledgeTier,
        pledge_amount:   pledgeAmount,
        start_time:      now,
        end_time:        endDate,
        required_proofs: requiredProofs,
        status:          'created',
      });

      res.json({ ok: true, id: commitment.id });
    } catch (err) {
      console.error('[api] POST /api/commitment/register error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  /**
   * GET /api/pool
   * Return active commitment count (used by snap for pool stats).
   */
  app.get('/api/pool', async (req: Request, res: Response) => {
    if (!verifySnapSecret(req, res)) return;
    try {
      const activeCount = await countActiveCommitments();
      res.json({ activeCount });
    } catch {
      res.json({ activeCount: 0 });
    }
  });

  app.get('/api/snap/status', async (req: Request, res: Response) => {
    const fid = Number(req.query.fid);
    if (!fid || isNaN(fid)) return void res.status(400).json({ found: false });

    try {
      const commitment = await getActiveCommitmentByFid(fid);
      if (!commitment) return void res.json({ found: false });

      const now = Date.now();
      const elapsed = (now - commitment.start_time.getTime()) /
                      (commitment.end_time.getTime() - commitment.start_time.getTime());
      const onTrack = commitment.verified_proofs >= Math.floor(elapsed * commitment.required_proofs);
      const daysLeft = Math.max(0, Math.ceil((commitment.end_time.getTime() - now) / 86_400_000));

      const [proofs, user] = await Promise.all([
        getProofsByCommitmentId(commitment.id),
        getUserByFid(fid),
      ]);
      const lastProof = proofs[proofs.length - 1];

      res.json({
        found:          true,
        username:       user?.username ?? String(fid),
        template:       commitment.template,
        verifiedProofs: commitment.verified_proofs,
        requiredProofs: commitment.required_proofs,
        daysLeft,
        pledgeAmount:   commitment.pledge_amount,
        onTrack,
        lastProofAt:    lastProof?.created_at.toISOString() ?? null,
      });
    } catch (err) {
      console.error('[api] GET /api/snap/status error:', err);
      res.status(500).json({ found: false });
    }
  });

  app.get('/api/snap/templates', async (_req: Request, res: Response) => {
    const TEMPLATES = [
      { name: '15-day', label: '15 days', duration: 15, proofs: 10, amount: 5_000  },
      { name: '30-day', label: '30 days', duration: 30, proofs: 20, amount: 10_000 },
    ];
    try {
      const r = await query<{ passed: string; ended: string }>(
        `SELECT COUNT(*) FILTER (WHERE outcome = 'passed') AS passed,
                COUNT(*) FILTER (WHERE status = 'end')     AS ended
         FROM commitments`,
        []
      );
      const { passed, ended } = r.rows[0];
      const successRate = Number(ended) > 0 ? Math.round((Number(passed) / Number(ended)) * 100) : 0;
      res.json(TEMPLATES.map(t => ({ ...t, successRate })));
    } catch (err) {
      console.error('[api] GET /api/snap/templates error:', err);
      res.json(TEMPLATES.map(t => ({ ...t, successRate: 0 })));
    }
  });

  app.get('/api/snap/leaderboard', async (_req: Request, res: Response) => {
    const now = new Date();
    const daysFromMon = (now.getUTCDay() + 6) % 7;
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMon));
    const weekEnd   = new Date(weekStart.getTime() + 7 * 86_400_000);

    try {
      const [topRows, statsRow, poolRow] = await Promise.all([
        query<{ fid: string; verified_proofs: number; template: string }>(
          `SELECT fid, verified_proofs, template
           FROM commitments
           WHERE (status IN ('created','paid') OR outcome = 'passed')
             AND created_at >= $1 AND created_at < $2
           ORDER BY verified_proofs DESC
           LIMIT 5`,
          [weekStart, weekEnd]
        ),
        query<{ active: string; passed: string; failed: string }>(
          `SELECT COUNT(*) FILTER (WHERE status IN ('created','paid'))           AS active,
                  COUNT(*) FILTER (WHERE status = 'end' AND outcome = 'passed') AS passed,
                  COUNT(*) FILTER (WHERE status = 'end' AND outcome = 'failed') AS failed
           FROM commitments
           WHERE created_at >= $1 AND created_at < $2`,
          [weekStart, weekEnd]
        ),
        query<{ balance: string }>(
          `SELECT COALESCE(SUM(CASE WHEN event_type IN ('seed','failure') THEN amount ELSE -amount END), 0) AS balance
           FROM pool_events
           WHERE event_type IN ('seed','failure','payout')`,
          []
        ),
      ]);

      const fids = topRows.rows.map(r => Number(r.fid));
      const usernameMap = new Map<number, string>();
      if (fids.length > 0) {
        const users = await neynar.fetchBulkUsers({ fids });
        users.users.forEach(u => usernameMap.set(u.fid, u.username));
      }

      const sun = new Date(weekEnd.getTime() - 86_400_000);
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const sm = MONTHS[weekStart.getUTCMonth()];
      const em = MONTHS[sun.getUTCMonth()];
      const week = sm === em
        ? `${sm} ${weekStart.getUTCDate()}–${sun.getUTCDate()}`
        : `${sm} ${weekStart.getUTCDate()}–${em} ${sun.getUTCDate()}`;

      res.json({
        week,
        topUsers: topRows.rows.map(r => ({
          fid:      Number(r.fid),
          username: usernameMap.get(Number(r.fid)) ?? String(r.fid),
          proofs:   r.verified_proofs,
          template: r.template,
        })),
        stats: {
          active:      Number(statsRow.rows[0].active),
          passed:      Number(statsRow.rows[0].passed),
          failed:      Number(statsRow.rows[0].failed),
          poolBalance: Number(poolRow.rows[0].balance),
        },
      });
    } catch (err) {
      console.error('[api] GET /api/snap/leaderboard error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/snap/social', async (req: Request, res: Response) => {
    const fid = Number(req.query.fid);
    if (!fid || isNaN(fid)) return void res.status(400).json({ followingActive: 0, names: [] });

    try {
      const followingResp = await neynar.fetchUserFollowing({ fid, limit: 100 });
      const followingFids = followingResp.users.map(f => f.user.fid);

      if (followingFids.length === 0) return void res.json({ followingActive: 0, names: [] });

      const r = await query<{ fid: string }>(
        `SELECT DISTINCT fid FROM commitments
         WHERE status IN ('created','paid') AND end_time > NOW() AND fid = ANY($1)`,
        [followingFids]
      );

      const activeFids = r.rows.map(row => Number(row.fid));
      if (activeFids.length === 0) return void res.json({ followingActive: 0, names: [] });

      const users = await neynar.fetchBulkUsers({ fids: activeFids });
      const names = users.users.map(u => u.username);

      res.json({ followingActive: activeFids.length, names });
    } catch (err) {
      console.error('[api] GET /api/snap/social error:', err);
      res.json({ followingActive: 0, names: [] });
    }
  });

  app.listen(PORT, () => {
    console.log(`[boot] listening on port ${PORT}`);
  });

  registerCronJobs();
  registerNudgeCron();
}

main().catch(err => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
