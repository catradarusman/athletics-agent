-- ─── Higher Athletics Agent — Database Schema ────────────────────────────────
--
-- Apply with:
--   psql $DATABASE_URL -f src/db/schema.sql
--
-- All timestamps are stored as UTC (no time zone).
-- pledge_amount stores whole HIGHER tokens (1000 / 5000 / 10000 / 25000),
-- not wei — the contract layer converts to/from 18-decimal representation.

-- ─── commitments ─────────────────────────────────────────────────────────────
-- Mirrors the onchain Commitment struct. A row is inserted when a user
-- announces intent; commitment_id is backfilled once the tx confirms.

CREATE TABLE IF NOT EXISTS commitments (
  id               SERIAL        PRIMARY KEY,
  commitment_id    INTEGER,                              -- onchain ID, null until tx confirmed
  fid              BIGINT        NOT NULL,               -- Farcaster ID
  wallet_address   TEXT          NOT NULL,
  template         TEXT          NOT NULL,               -- user-written goal description
  pledge_tier      TEXT          NOT NULL,               -- Starter | Standard | Serious | All-in
  pledge_amount    BIGINT        NOT NULL,               -- whole HIGHER tokens (max 25000)
  start_time       TIMESTAMP     NOT NULL,
  end_time         TIMESTAMP     NOT NULL,
  required_proofs  INTEGER       NOT NULL,
  verified_proofs  INTEGER       NOT NULL DEFAULT 0,
  status           TEXT          NOT NULL DEFAULT 'active', -- active | pending_onchain | passed | failed | claimed
  created_at       TIMESTAMP     NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMP,
  tx_hash          TEXT                                  -- creation transaction hash
);

-- ─── proofs ──────────────────────────────────────────────────────────────────
-- Each row is a Farcaster cast submitted as proof of workout.
-- cast_hash is unique — duplicate casts are silently rejected by the agent.

CREATE TABLE IF NOT EXISTS proofs (
  id               SERIAL        PRIMARY KEY,
  commitment_id    INTEGER       REFERENCES commitments(id),
  cast_hash        TEXT          NOT NULL UNIQUE,        -- Farcaster cast hash (0x...)
  fid              BIGINT        NOT NULL,
  cast_text        TEXT,                                 -- full cast content
  has_image        BOOLEAN       NOT NULL DEFAULT FALSE,
  ai_valid         BOOLEAN,                              -- Claude validation result
  ai_reason        TEXT,                                 -- Claude explanation
  ai_summary       TEXT,                                 -- 3-word dedup summary
  recorded_onchain BOOLEAN       NOT NULL DEFAULT FALSE,
  onchain_tx_hash  TEXT,
  created_at       TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- ─── pool_events ─────────────────────────────────────────────────────────────
-- Audit log of treasury movements: seeds, forfeited pledges, payouts, fee withdrawals.

CREATE TABLE IF NOT EXISTS pool_events (
  id             SERIAL      PRIMARY KEY,
  event_type     TEXT        NOT NULL,                   -- seed | failure | payout | fee_withdrawal
  amount         BIGINT      NOT NULL,                   -- whole HIGHER tokens
  commitment_id  INTEGER     REFERENCES commitments(id), -- nullable for seed / fee_withdrawal events
  tx_hash        TEXT,
  created_at     TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- getActiveCommitmentByFid: equality on fid, then filter by status
CREATE INDEX IF NOT EXISTS idx_commitments_fid_status
  ON commitments (fid, status);

-- getExpiredActiveCommitments: equality on status, range on end_time
CREATE INDEX IF NOT EXISTS idx_commitments_status_end_time
  ON commitments (status, end_time);

-- getProofsByCommitmentId: pg does not auto-create indexes for FK columns
CREATE INDEX IF NOT EXISTS idx_proofs_commitment_id
  ON proofs (commitment_id);

-- pool_events FK lookup
CREATE INDEX IF NOT EXISTS idx_pool_events_commitment_id
  ON pool_events (commitment_id);
