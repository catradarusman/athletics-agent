import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { initDb } from './db/index.js';
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
import { getUserByFid } from './agent/bot.js';

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
