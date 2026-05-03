/**
 * Integration test: HigherCommitmentPool contract + DB
 *
 * Tests the full commitment lifecycle on a local Hardhat network with a real
 * PostgreSQL database. Verifies that contract state and DB state stay in sync
 * across every phase: create → proof recording → resolution → claim.
 *
 * Prerequisites:
 *   1. DATABASE_URL set in .env (pointing at a real Postgres instance)
 *   2. Schema applied:  psql $DATABASE_URL -f src/db/schema.sql
 *   3. Contracts compiled: npx hardhat compile
 *
 * Run:
 *   npx hardhat test src/test/integration.ts --network hardhat
 */

// ── dotenv MUST be first — db/index.ts throws at load if DATABASE_URL is missing
import 'dotenv/config';

import { expect }                             from 'chai';
import { loadFixture, time }                  from '@nomicfoundation/hardhat-network-helpers';
import hre                                    from 'hardhat';
import { pool as pgPool, initDb, query }      from '../db/index.js';
import {
  createCommitment,
  updateCommitmentStatus,
  markCommitmentClaimed,
  getCommitmentById,
  recordProof         as dbRecordProof,
  getProofsByCommitmentId,
  type Commitment,
}                                             from '../db/queries.js';

const { ethers } = hre;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert whole tokens to 18-decimal wei (as bigint). */
const T = (n: number) => ethers.parseUnits(String(n), 18);

/**
 * Parse a named event from a transaction receipt.
 * Returns the first matching event's args, or throws.
 */
function parseEvent(
  receipt: Awaited<ReturnType<Awaited<ReturnType<typeof ethers.getContractFactory>>['deploy']>['deploymentTransaction']>['wait'] extends (...a: any[]) => Promise<infer R> ? R : never,
  contract: Awaited<ReturnType<Awaited<ReturnType<typeof ethers.getContractFactory>>['deploy']>>,
  eventName: string,
): ReturnType<typeof contract.interface.parseLog> {
  for (const log of (receipt as any).logs) {
    try {
      const parsed = (contract as any).interface.parseLog(log);
      if (parsed?.name === eventName) return parsed as any;
    } catch {
      // not this fragment — skip
    }
  }
  throw new Error(`Event ${eventName} not found in receipt`);
}

// ─── Constants ────────────────────────────────────────────────────────────────

// A high FID that won't collide with real Farcaster user data in the DB.
const TEST_FID  = 9_999_001;
const SEED      = T(100_000);

// Pledge math for Starter tier (1 000 HIGHER):
//   fee      = pledge × 10%        =   100
//   bonusCap = pledge × 50%        =   500
//   poolShare = seed × 2%          = 2 000
//   bonus    = min(bonusCap, poolShare) = 500
//   payout   = pledge − fee + bonus = 1 400
const PLEDGE    = T(1_000);
const FEE       = PLEDGE * 10n / 100n;       // 100 HIGHER
const BONUS_CAP = PLEDGE * 50n / 100n;       // 500 HIGHER
const POOL_2PCT = SEED   *  2n / 100n;       // 2 000 HIGHER
const BONUS     = BONUS_CAP < POOL_2PCT ? BONUS_CAP : POOL_2PCT; // 500
const PAYOUT    = PLEDGE - FEE + BONUS;      // 1 400 HIGHER

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function deployFixture() {
  const [admin, agentSigner, feeRecipient, user] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const token     = await MockERC20.deploy('Higher', 'HIGHER');
  const tokenAddr = await token.getAddress();

  const Pool     = await ethers.getContractFactory('HigherCommitmentPool');
  const pool     = await Pool.deploy(tokenAddr, feeRecipient.address, agentSigner.address);
  const poolAddr = await pool.getAddress();

  // Fund wallets and grant allowances
  await token.mint(admin.address, T(500_000));
  await token.mint(user.address,  T(50_000));
  for (const signer of [admin, user]) {
    await token.connect(signer).approve(poolAddr, ethers.MaxUint256);
  }

  // Seed the prize pool so bonuses can be paid
  await pool.connect(admin).seedPool(SEED);

  return { pool, token, poolAddr, tokenAddr, admin, agentSigner, feeRecipient, user };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** Directly update verified_proofs on a commitment row (no application-layer function exists for this yet). */
async function setDbVerifiedProofs(dbId: number, count: number): Promise<void> {
  await query('UPDATE commitments SET verified_proofs = $2 WHERE id = $1', [dbId, count]);
}

/** Remove all test data for TEST_FID so tests don't bleed into each other. */
async function cleanTestData(): Promise<void> {
  await query('DELETE FROM proofs      WHERE fid = $1', [TEST_FID]);
  await query('DELETE FROM commitments WHERE fid = $1', [TEST_FID]);
}

/** Insert DB commitment record linked to an already-created onchain commitment. */
async function insertDbCommitment(
  onchainId: number,
  userAddress: string,
  requiredProofs: number,
): Promise<Commitment> {
  const now = new Date();
  return createCommitment({
    commitment_id:   onchainId,
    fid:             TEST_FID,
    wallet_address:  userAddress,
    template:        'sprint',
    pledge_tier:     'Starter',
    pledge_amount:   1_000,
    start_time:      now,
    end_time:        new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    required_proofs: requiredProofs,
  });
}

/** Record a proof in both DB and onchain via the agent signer. */
async function recordProof(
  pool: any,
  agentSigner: any,
  dbId: number,
  onchainId: number,
  index: number,
): Promise<void> {
  // DB record (represents a validated cast)
  await dbRecordProof({
    commitment_id: dbId,
    cast_hash:     `0x${String(index).padStart(64, '0')}`,
    fid:           TEST_FID,
    cast_text:     `proof cast ${index}`,
    has_image:     false,
    ai_valid:      true,
    ai_reason:     'confirmed by integration test',
    ai_summary:    `session ${index} verified`,
  });

  // Onchain record (agent role required)
  await pool.connect(agentSigner).recordProof(onchainId);
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Integration: HigherCommitmentPool + DB', function () {
  this.timeout(120_000); // DB + contract ops can take time

  before(async function () {
    await initDb();
  });

  after(async function () {
    await pgPool.end();
  });

  afterEach(cleanTestData);

  // ── Happy path ───────────────────────────────────────────────────────────────

  describe('Happy path — commitment passes', function () {
    it('create → 3 proofs → resolve → claim: balances and DB status correct', async function () {
      const { pool, token, admin, agentSigner, feeRecipient, user } =
        await loadFixture(deployFixture);

      // ── Step 1: Create commitment onchain ────────────────────────────────────
      // Starter tier (index 0) = 1 000 HIGHER, 7-day window, 3 proofs required
      const createTx      = await pool.connect(user).createCommitment(TEST_FID, 0, 7, 3);
      const createReceipt = await createTx.wait();
      const createEvent   = parseEvent(createReceipt, pool, 'CommitmentCreated');
      const onchainId     = Number(createEvent.args.commitmentId);

      // Verify onchain commitment is Active with correct params
      const onchainC = await pool.commitments(onchainId);
      expect(onchainC.status).to.equal(0);           // Active
      expect(onchainC.requiredProofs).to.equal(3n);
      expect(onchainC.pledgeAmount).to.equal(PLEDGE);

      // ── Step 2: Mirror commitment in DB ──────────────────────────────────────
      const dbC = await insertDbCommitment(onchainId, user.address, 3);

      expect(dbC.status).to.equal('created');
      expect(dbC.commitment_id).to.equal(onchainId);
      expect(dbC.required_proofs).to.equal(3);
      expect(dbC.pledge_amount).to.equal(1_000);

      // ── Step 3: Record 3 proofs (DB + onchain) ───────────────────────────────
      for (let i = 1; i <= 3; i++) {
        await recordProof(pool, agentSigner, dbC.id, onchainId, i);
      }

      // Keep DB verified_proofs in sync (production: done by webhook handler)
      await setDbVerifiedProofs(dbC.id, 3);

      // Verify DB proof records
      const proofs = await getProofsByCommitmentId(dbC.id);
      expect(proofs).to.have.length(3);
      expect(proofs.every(p => p.ai_valid === true)).to.be.true;
      expect(proofs.every(p => p.fid === TEST_FID)).to.be.true;

      // Verify onchain proof count
      const afterProofs = await pool.commitments(onchainId);
      expect(afterProofs.verifiedProofs).to.equal(3n);

      // ── Step 4: Fast-forward past endTime and resolve ────────────────────────
      await time.increase(7 * 24 * 60 * 60 + 1); // 7 days + 1 second

      // Capture balances before claim (not before resolve — resolve doesn't move tokens)
      const userBalBefore = await token.balanceOf(user.address);
      const poolBefore    = await pool.prizePool();
      const feesBefore    = await pool.accumulatedFees();

      const resolveTx      = await pool.connect(agentSigner).resolveCommitment(onchainId);
      const resolveReceipt = await resolveTx.wait();
      const resolveEvent   = parseEvent(resolveReceipt, pool, 'CommitmentResolved');

      // Status 1 = Passed
      expect(resolveEvent.args.status).to.equal(1n);
      expect((await pool.commitments(onchainId)).status).to.equal(1);

      // Mirror resolution in DB (production: done by resolution cron)
      await updateCommitmentStatus(dbC.id, 'passed', new Date());

      const dbAfterResolve = await getCommitmentById(dbC.id);
      expect(dbAfterResolve!.status).to.equal('end');
      expect(dbAfterResolve!.outcome).to.equal('passed');
      expect(dbAfterResolve!.resolved_at).to.be.instanceOf(Date);

      // ── Step 5: Claim reward ─────────────────────────────────────────────────
      const claimTx      = await pool.connect(user).claim(onchainId);
      const claimReceipt = await claimTx.wait();
      parseEvent(claimReceipt, pool, 'CommitmentClaimed'); // asserts event was emitted

      expect((await pool.commitments(onchainId)).status).to.equal(3); // Claimed

      // Mirror in DB
      await markCommitmentClaimed(dbC.id);
      const dbAfterClaim = await getCommitmentById(dbC.id);
      expect(dbAfterClaim!.status).to.equal('claimed');

      // ── Step 6: User got pledge − fee + bonus ────────────────────────────────
      // PAYOUT = 1 000 − 100 + 500 = 1 400 HIGHER
      const userBalAfter = await token.balanceOf(user.address);
      expect(userBalAfter - userBalBefore).to.equal(
        PAYOUT,
        `expected payout ${ethers.formatUnits(PAYOUT, 18)} HIGHER`,
      );

      // ── Step 7: Pool decreased by bonus ──────────────────────────────────────
      const poolAfter = await pool.prizePool();
      expect(poolBefore - poolAfter).to.equal(
        BONUS,
        `expected pool to decrease by ${ethers.formatUnits(BONUS, 18)} HIGHER`,
      );

      // ── Step 8: Fee recipient accumulated 10% fee ────────────────────────────
      // Fees are held in accumulatedFees until admin calls withdrawFees().
      const feesAfter = await pool.accumulatedFees();
      expect(feesAfter - feesBefore).to.equal(
        FEE,
        `expected fee ${ethers.formatUnits(FEE, 18)} HIGHER`,
      );
    });
  });

  // ── Failure path ─────────────────────────────────────────────────────────────

  describe('Failure path — commitment fails', function () {
    it('1 of 3 proofs → resolve fails → full pledge to pool → user cannot claim', async function () {
      const { pool, token, agentSigner, user } = await loadFixture(deployFixture);

      // ── Step 1: Create commitment (3 proofs required) ────────────────────────
      const createTx      = await pool.connect(user).createCommitment(TEST_FID, 0, 7, 3);
      const createReceipt = await createTx.wait();
      const onchainId     = Number(parseEvent(createReceipt, pool, 'CommitmentCreated').args.commitmentId);

      const dbC = await insertDbCommitment(onchainId, user.address, 3);
      expect(dbC.status).to.equal('created');

      // ── Step 2: Record only 1 proof (under the 3 required) ──────────────────
      await recordProof(pool, agentSigner, dbC.id, onchainId, 1);
      await setDbVerifiedProofs(dbC.id, 1);

      const onchainAfterProof = await pool.commitments(onchainId);
      expect(onchainAfterProof.verifiedProofs).to.equal(1n);

      const dbAfterProof = await getCommitmentById(dbC.id);
      expect(dbAfterProof!.verified_proofs).to.equal(1);

      // ── Step 3: Fast-forward past endTime ────────────────────────────────────
      await time.increase(7 * 24 * 60 * 60 + 1);

      const poolBefore = await pool.prizePool();

      // ── Step 4: Resolve — should fail (1 < 3) ───────────────────────────────
      const resolveTx      = await pool.connect(agentSigner).resolveCommitment(onchainId);
      const resolveReceipt = await resolveTx.wait();
      const resolveEvent   = parseEvent(resolveReceipt, pool, 'CommitmentResolved');

      // Status 2 = Failed
      expect(resolveEvent.args.status).to.equal(2n);
      expect((await pool.commitments(onchainId)).status).to.equal(2);

      // Mirror in DB
      await updateCommitmentStatus(dbC.id, 'failed', new Date());

      const dbFailed = await getCommitmentById(dbC.id);
      expect(dbFailed!.status).to.equal('end');
      expect(dbFailed!.outcome).to.equal('failed');
      expect(dbFailed!.resolved_at).to.be.instanceOf(Date);

      // ── Step 5: Full pledge forfeited to prize pool ──────────────────────────
      const poolAfter = await pool.prizePool();
      expect(poolAfter - poolBefore).to.equal(
        PLEDGE,
        `expected full pledge ${ethers.formatUnits(PLEDGE, 18)} HIGHER forfeited to pool`,
      );

      // ── Step 6: User cannot claim a failed commitment ────────────────────────
      await expect(pool.connect(user).claim(onchainId))
        .to.be.revertedWith('Commitment not passed');

      // DB status must remain 'end'/'failed' — no update on a failed claim attempt
      const dbStillFailed = await getCommitmentById(dbC.id);
      expect(dbStillFailed!.status).to.equal('end');
      expect(dbStillFailed!.outcome).to.equal('failed');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────────

  describe('Edge cases', function () {
    it('cannot resolve before endTime', async function () {
      const { pool, agentSigner, user } = await loadFixture(deployFixture);

      const tx      = await pool.connect(user).createCommitment(TEST_FID, 0, 7, 1);
      const receipt = await tx.wait();
      const id      = Number(parseEvent(receipt, pool, 'CommitmentCreated').args.commitmentId);

      await expect(pool.connect(agentSigner).resolveCommitment(id))
        .to.be.revertedWith('Commitment window not closed');
    });

    it('cannot record proof after endTime', async function () {
      const { pool, agentSigner, user } = await loadFixture(deployFixture);

      const tx      = await pool.connect(user).createCommitment(TEST_FID, 0, 7, 3);
      const receipt = await tx.wait();
      const id      = Number(parseEvent(receipt, pool, 'CommitmentCreated').args.commitmentId);

      await time.increase(7 * 24 * 60 * 60 + 1);

      await expect(pool.connect(agentSigner).recordProof(id))
        .to.be.revertedWith('Commitment window closed');
    });

    it('exactly meeting the proof threshold passes', async function () {
      const { pool, agentSigner, user } = await loadFixture(deployFixture);

      // 7-day window, exactly 7 proofs (1/day)
      const tx      = await pool.connect(user).createCommitment(TEST_FID, 0, 7, 7);
      const receipt = await tx.wait();
      const id      = Number(parseEvent(receipt, pool, 'CommitmentCreated').args.commitmentId);

      for (let i = 0; i < 7; i++) await pool.connect(agentSigner).recordProof(id);

      await time.increase(7 * 24 * 60 * 60 + 1);
      await pool.connect(agentSigner).resolveCommitment(id);

      expect((await pool.commitments(id)).status).to.equal(1); // Passed
    });

    it('DB status transitions are sequential and reflected in getCommitmentById', async function () {
      const { pool, user } = await loadFixture(deployFixture);

      const tx      = await pool.connect(user).createCommitment(TEST_FID, 0, 7, 1);
      const receipt = await tx.wait();
      const id      = Number(parseEvent(receipt, pool, 'CommitmentCreated').args.commitmentId);

      const created = await insertDbCommitment(id, user.address, 1);
      expect(created.status).to.equal('created');
      expect(created.resolved_at).to.be.null;

      const resolvedAt = new Date();
      await updateCommitmentStatus(created.id, 'passed', resolvedAt);
      const afterPass = await getCommitmentById(created.id);
      expect(afterPass!.status).to.equal('end');
      expect(afterPass!.outcome).to.equal('passed');
      expect(afterPass!.resolved_at).to.not.be.null;

      await markCommitmentClaimed(created.id);
      const afterClaim = await getCommitmentById(created.id);
      expect(afterClaim!.status).to.equal('claimed');
    });

    it('non-agent cannot call recordProof', async function () {
      const { pool, user } = await loadFixture(deployFixture);

      const tx      = await pool.connect(user).createCommitment(TEST_FID, 0, 7, 1);
      const receipt = await tx.wait();
      const id      = Number(parseEvent(receipt, pool, 'CommitmentCreated').args.commitmentId);

      await expect(pool.connect(user).recordProof(id))
        .to.be.revertedWithCustomError(pool, 'AccessControlUnauthorizedAccount');
    });
  });
});
