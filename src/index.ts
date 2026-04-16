import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { initDb } from './db/index.js';
import { webhookRouter } from './agent/webhook.js';
import { registerCronJobs } from './agent/cron.js';
import {
  getLatestCommitmentByFid,
  getActiveCommitmentByFid,
  createCommitment,
  countActiveCommitments,
  type PledgeTier,
} from './db/queries.js';

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

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ─── Snap API ──────────────────────────────────────────────────────────────

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
      res.json({
        status:          commitment.status,
        id:              commitment.id,
        commitment_id:   commitment.commitment_id,
        template:        commitment.template,
        verified_proofs: commitment.verified_proofs,
        required_proofs: commitment.required_proofs,
        pledge_amount:   commitment.pledge_amount,
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
   * Creates a pending_onchain DB record before the user signs the tx.
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
        status:          'pending_onchain',
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

  app.listen(PORT, () => {
    console.log(`[boot] listening on port ${PORT}`);
  });

  registerCronJobs();
}

main().catch(err => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
