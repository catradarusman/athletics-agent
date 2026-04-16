import { query, pool } from './index.js';

// ─── Domain types ─────────────────────────────────────────────────────────────

export type CommitmentStatus = 'active' | 'pending_onchain' | 'passed' | 'failed' | 'claimed';
export type PledgeTier       = 'Standard' | 'Serious';
export type PoolEventType    = 'seed' | 'failure' | 'payout' | 'fee_withdrawal';

export interface Commitment {
  id:              number;
  commitment_id:   number | null;  // onchain ID; null until tx confirmed
  fid:             number;
  wallet_address:  string;
  template:        string;
  pledge_tier:     PledgeTier;
  pledge_amount:   number;         // whole HIGHER tokens
  start_time:      Date;
  end_time:        Date;
  required_proofs: number;
  verified_proofs: number;
  status:          CommitmentStatus;
  created_at:      Date;
  resolved_at:     Date | null;
  tx_hash:         string | null;
}

export interface Proof {
  id:               number;
  commitment_id:    number;
  cast_hash:        string;
  fid:              number;
  cast_text:        string | null;
  has_image:        boolean;
  ai_valid:         boolean | null;
  ai_reason:        string | null;
  ai_summary:       string | null;
  recorded_onchain: boolean;
  onchain_tx_hash:  string | null;
  created_at:       Date;
}

export interface PoolEvent {
  id:            number;
  event_type:    PoolEventType;
  amount:        number;
  commitment_id: number | null;
  tx_hash:       string | null;
  created_at:    Date;
}

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateCommitmentInput {
  commitment_id?:  number | null;
  fid:             number;
  wallet_address:  string;
  template:        string;
  pledge_tier:     PledgeTier;
  pledge_amount:   number;
  start_time:      Date;
  end_time:        Date;
  required_proofs: number;
  tx_hash?:        string | null;
  status?:         CommitmentStatus;  // defaults to 'active' in DB if omitted
}

export interface RecordProofInput {
  commitment_id:   number;
  cast_hash:       string;
  fid:             number;
  cast_text?:      string | null;
  has_image?:      boolean;
  ai_valid?:       boolean | null;
  ai_reason?:      string | null;
  ai_summary?:     string | null;
}

// ─── Row helpers ──────────────────────────────────────────────────────────────
// pg returns snake_case keys matching column names and auto-parses TIMESTAMP →
// JS Date. These casts verify the shape without a runtime transform pass.

function toCommitment(row: Record<string, unknown>): Commitment {
  return row as unknown as Commitment;
}

function toProof(row: Record<string, unknown>): Proof {
  return row as unknown as Proof;
}

// ─── Query functions ──────────────────────────────────────────────────────────

/**
 * Insert a new commitment row. Defaulted columns (verified_proofs, status,
 * created_at) are omitted from the INSERT so DB defaults apply.
 */
export async function createCommitment(
  data: CreateCommitmentInput
): Promise<Commitment> {
  const result = await query<Record<string, unknown>>(
    `INSERT INTO commitments
       (commitment_id, fid, wallet_address, template, pledge_tier,
        pledge_amount, start_time, end_time, required_proofs, tx_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'active'))
     RETURNING *`,
    [
      data.commitment_id ?? null,
      data.fid,
      data.wallet_address,
      data.template,
      data.pledge_tier,
      data.pledge_amount,
      data.start_time,
      data.end_time,
      data.required_proofs,
      data.tx_hash ?? null,
      data.status   ?? null,
    ]
  );
  return toCommitment(result.rows[0]);
}

/**
 * Return the single active commitment for a FID, or null if none exists.
 * A user may only have one active commitment at a time (enforced onchain and
 * here at the query level via LIMIT 1).
 */
export async function getActiveCommitmentByFid(
  fid: number
): Promise<Commitment | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM commitments
     WHERE fid = $1 AND status IN ('active', 'pending_onchain')
     LIMIT 1`,
    [fid]
  );
  return result.rows[0] ? toCommitment(result.rows[0]) : null;
}

/**
 * Insert a proof row and atomically increment commitments.verified_proofs.
 * cast_hash has a UNIQUE constraint — if the same cast is submitted twice,
 * pg will throw error code '23505'. The calling agent should catch that and
 * treat it as a no-op duplicate.
 */
export async function recordProof(data: RecordProofInput): Promise<Proof> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const proofResult = await client.query<Record<string, unknown>>(
      `INSERT INTO proofs
         (commitment_id, cast_hash, fid, cast_text, has_image,
          ai_valid, ai_reason, ai_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.commitment_id,
        data.cast_hash,
        data.fid,
        data.cast_text  ?? null,
        data.has_image  ?? false,
        data.ai_valid   ?? null,
        data.ai_reason  ?? null,
        data.ai_summary ?? null,
      ]
    );

    await client.query(
      `UPDATE commitments SET verified_proofs = verified_proofs + 1 WHERE id = $1`,
      [data.commitment_id]
    );

    await client.query('COMMIT');
    return toProof(proofResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Backfill the onchain commitment ID once the user's createCommitment tx confirms.
 */
export async function backfillCommitmentId(id: number, commitmentId: number): Promise<void> {
  await query(
    `UPDATE commitments SET commitment_id = $2, status = 'active' WHERE id = $1`,
    [id, commitmentId]
  );
}

/**
 * Return all proofs for a commitment in ascending chronological order.
 */
export async function getProofsByCommitmentId(
  commitmentId: number
): Promise<Proof[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM proofs
     WHERE commitment_id = $1
     ORDER BY created_at ASC`,
    [commitmentId]
  );
  return result.rows.map(toProof);
}

/**
 * Update a commitment's status and optionally set resolved_at.
 * Throws if no row is matched — a missing ID is a programming error.
 */
export async function updateCommitmentStatus(
  id: number,
  status: CommitmentStatus,
  resolvedAt?: Date
): Promise<Commitment> {
  let text: string;
  let values: unknown[];

  if (resolvedAt !== undefined) {
    text = `UPDATE commitments
            SET status = $2, resolved_at = $3
            WHERE id = $1
            RETURNING *`;
    values = [id, status, resolvedAt];
  } else {
    text = `UPDATE commitments
            SET status = $2
            WHERE id = $1
            RETURNING *`;
    values = [id, status];
  }

  const result = await query<Record<string, unknown>>(text, values);
  if (result.rows.length === 0) {
    throw new Error(`updateCommitmentStatus: commitment ${id} not found`);
  }
  return toCommitment(result.rows[0]);
}

/**
 * Return all active commitments whose end_time has passed.
 * Uses a Node-supplied Date rather than server-side NOW() so the query is
 * immune to the database server's timezone configuration.
 */
export async function getExpiredActiveCommitments(): Promise<Commitment[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM commitments
     WHERE status IN ('active', 'pending_onchain') AND end_time < $1
     ORDER BY end_time ASC`,
    [new Date()]
  );
  return result.rows.map(toCommitment);
}

/**
 * Fetch a single commitment by its DB primary key. Returns null if not found.
 */
export async function getCommitmentById(
  id: number
): Promise<Commitment | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM commitments WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? toCommitment(result.rows[0]) : null;
}

/**
 * Return all commitments with status = 'active'.
 */
export async function getAllActiveCommitments(): Promise<Commitment[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM commitments WHERE status IN ('active', 'pending_onchain') ORDER BY created_at ASC`,
    []
  );
  return result.rows.map(toCommitment);
}

/**
 * Insert a pool_events row for audit/logging.
 */
export async function recordPoolEvent(data: {
  event_type: PoolEventType;
  amount:        number;
  commitment_id?: number | null;
  tx_hash?:       string | null;
}): Promise<PoolEvent> {
  const result = await query<Record<string, unknown>>(
    `INSERT INTO pool_events (event_type, amount, commitment_id, tx_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      data.event_type,
      data.amount,
      data.commitment_id ?? null,
      data.tx_hash       ?? null,
    ]
  );
  return result.rows[0] as unknown as PoolEvent;
}

/**
 * Mark a proof as successfully recorded onchain.
 */
export async function updateProofOnchainStatus(
  proofId: number,
  txHash: string,
): Promise<void> {
  await query(
    `UPDATE proofs SET recorded_onchain = TRUE, onchain_tx_hash = $2 WHERE id = $1`,
    [proofId, txHash],
  );
}

/**
 * Return all valid proofs for a commitment that have NOT been recorded onchain.
 * Used by the reconciliation cron to retry failed onchain writes.
 */
export async function getUnrecordedProofs(commitmentId: number): Promise<Proof[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM proofs
     WHERE commitment_id = $1 AND ai_valid = TRUE AND recorded_onchain = FALSE
     ORDER BY created_at ASC`,
    [commitmentId],
  );
  return result.rows.map(toProof);
}

/**
 * Return top N users by completed (passed/claimed) commitments.
 */
export async function getLeaderboard(limit: number = 10): Promise<Array<{ fid: number; completed: number }>> {
  const result = await query<Record<string, unknown>>(
    `SELECT fid, COUNT(*) AS completed
     FROM commitments
     WHERE status IN ('passed', 'claimed')
     GROUP BY fid
     ORDER BY completed DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map(r => ({
    fid:       Number((r as { fid: number }).fid),
    completed: Number((r as { completed: string }).completed),
  }));
}

/**
 * Return the count of active/pending commitments without loading full rows.
 * Used by the snap API to display pool stats.
 */
export async function countActiveCommitments(): Promise<number> {
  const result = await query<Record<string, unknown>>(
    `SELECT COUNT(*) AS count FROM commitments WHERE status IN ('active', 'pending_onchain')`,
    []
  );
  return parseInt((result.rows[0] as { count: string }).count, 10);
}

/**
 * Return the most recent non-claimed commitment for a FID, regardless of status.
 * Used by the snap API to surface passed/pending commitments for the claim flow.
 */
export async function getLatestCommitmentByFid(
  fid: number
): Promise<Commitment | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM commitments
     WHERE fid = $1 AND status IN ('active', 'pending_onchain', 'passed', 'failed')
     ORDER BY created_at DESC
     LIMIT 1`,
    [fid]
  );
  return result.rows[0] ? toCommitment(result.rows[0]) : null;
}

/**
 * Return counts of commitments resolved as 'passed' or 'failed' since the
 * given cutoff date. Used by the weekly pool update cron.
 */
export async function getWeeklyResolutionStats(since: Date): Promise<{
  passed: number;
  failed: number;
}> {
  const result = await query<Record<string, unknown>>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'passed') AS passed,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed
     FROM commitments
     WHERE status IN ('passed', 'failed', 'claimed')
       AND resolved_at >= $1`,
    [since]
  );
  const row = result.rows[0] as { passed: string; failed: string };
  return {
    passed: parseInt(row.passed, 10),
    failed: parseInt(row.failed, 10),
  };
}
