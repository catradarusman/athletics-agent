import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";

const { ethers } = hre;

// ─── Constants ───────────────────────────────────────────────────────────────
const AGENT_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("AGENT_ROLE"));
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

const T = (n) => ethers.parseUnits(String(n), 18); // token amount helper

const TIERS = [T(1_000), T(5_000), T(10_000), T(25_000)];
const SEED  = T(100_000);

const FID1 = 1001n;
const FID2 = 1002n;

// ─── Fixture ─────────────────────────────────────────────────────────────────
async function deployFixture() {
  const [admin, agentSigner, feeRecipient, user1, user2, stranger] =
    await ethers.getSigners();

  // Deploy mock token
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("Higher", "HIGHER");

  // Deploy pool
  const Pool = await ethers.getContractFactory("HigherCommitmentPool");
  const pool = await Pool.deploy(
    await token.getAddress(),
    feeRecipient.address,
    agentSigner.address
  );

  const poolAddr = await pool.getAddress();

  // Fund participants
  await token.mint(admin.address,    T(500_000));
  await token.mint(user1.address,    T(50_000));
  await token.mint(user2.address,    T(50_000));

  // Approve pool for all
  for (const signer of [admin, user1, user2]) {
    await token.connect(signer).approve(poolAddr, ethers.MaxUint256);
  }

  // Admin seeds the prize pool
  await pool.connect(admin).seedPool(SEED);

  return { pool, token, admin, agentSigner, feeRecipient, user1, user2, stranger, poolAddr };
}

// Helper: create a basic 7-day/1-proof commitment for user1 on FID1
async function createBasicCommitment(pool, user1) {
  return pool.connect(user1).createCommitment(FID1, 0, 7, 1);
}

// Helper: advance past endTime and resolve
async function resolveAfterEnd(pool, agentSigner, id, endTime) {
  await time.increaseTo(endTime + 1n);
  return pool.connect(agentSigner).resolveCommitment(id);
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe("HigherCommitmentPool", function () {

  // ── Deployment ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("stores the correct token address", async function () {
      const { pool, token } = await loadFixture(deployFixture);
      expect(await pool.higherToken()).to.equal(await token.getAddress());
    });

    it("stores the correct feeRecipient", async function () {
      const { pool, feeRecipient } = await loadFixture(deployFixture);
      expect(await pool.feeRecipient()).to.equal(feeRecipient.address);
    });

    it("grants DEFAULT_ADMIN_ROLE to deployer", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      expect(await pool.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("grants AGENT_ROLE to agent", async function () {
      const { pool, agentSigner } = await loadFixture(deployFixture);
      expect(await pool.hasRole(AGENT_ROLE, agentSigner.address)).to.be.true;
    });

    it("sets pledge tiers correctly", async function () {
      const { pool } = await loadFixture(deployFixture);
      for (let i = 0; i < 4; i++) {
        expect(await pool.PLEDGE_TIERS(i)).to.equal(TIERS[i]);
      }
    });

    it("reverts on zero token address", async function () {
      const [admin, agent, fee] = await ethers.getSigners();
      const Pool = await ethers.getContractFactory("HigherCommitmentPool");
      await expect(
        Pool.deploy(ethers.ZeroAddress, fee.address, agent.address)
      ).to.be.revertedWith("Zero token address");
    });

    it("reverts on zero fee recipient", async function () {
      const [admin, agent] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("H", "H");
      const Pool = await ethers.getContractFactory("HigherCommitmentPool");
      await expect(
        Pool.deploy(await token.getAddress(), ethers.ZeroAddress, agent.address)
      ).to.be.revertedWith("Zero fee recipient");
    });
  });

  // ── seedPool ───────────────────────────────────────────────────────────────
  describe("seedPool", function () {
    it("increases prizePool and emits PoolSeeded", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      // SEED was already added in fixture; add another 50k
      const extra = T(50_000);
      await expect(pool.connect(admin).seedPool(extra))
        .to.emit(pool, "PoolSeeded")
        .withArgs(admin.address, extra);

      expect(await pool.prizePool()).to.equal(SEED + extra);
    });

    it("transfers tokens into the contract", async function () {
      const { pool, token, admin, poolAddr } = await loadFixture(deployFixture);
      const before = await token.balanceOf(poolAddr);
      await pool.connect(admin).seedPool(T(1_000));
      expect(await token.balanceOf(poolAddr)).to.equal(before + T(1_000));
    });

    it("reverts for non-admin", async function () {
      const { pool, stranger } = await loadFixture(deployFixture);
      await expect(pool.connect(stranger).seedPool(T(1_000)))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("reverts on zero amount", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).seedPool(0))
        .to.be.revertedWith("Amount must be > 0");
    });
  });

  // ── createCommitment ───────────────────────────────────────────────────────
  describe("createCommitment", function () {
    it("creates a commitment and locks tokens", async function () {
      const { pool, token, user1, poolAddr } = await loadFixture(deployFixture);
      const before = await token.balanceOf(poolAddr);

      const tx = await pool.connect(user1).createCommitment(FID1, 0, 7, 1);
      const receipt = await tx.wait();

      expect(await token.balanceOf(poolAddr)).to.equal(before + TIERS[0]);

      const c = await pool.commitments(0);
      expect(c.user).to.equal(user1.address);
      expect(c.fid).to.equal(FID1);
      expect(c.pledgeAmount).to.equal(TIERS[0]);
      expect(c.requiredProofs).to.equal(1n);
      expect(c.verifiedProofs).to.equal(0n);
      expect(c.status).to.equal(0); // Active
    });

    it("emits CommitmentCreated", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).createCommitment(FID1, 0, 7, 1))
        .to.emit(pool, "CommitmentCreated")
        .withArgs(0n, user1.address, FID1, TIERS[0], anyValue, 1n);
    });

    it("increments nextCommitmentId", async function () {
      const { pool, user1, user2 } = await loadFixture(deployFixture);
      await pool.connect(user1).createCommitment(FID1, 0, 7, 1);
      await pool.connect(user2).createCommitment(FID2, 1, 14, 2);
      expect(await pool.nextCommitmentId()).to.equal(2n);
    });

    it("sets fidHasActive for the FID", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).createCommitment(FID1, 0, 7, 1);
      expect(await pool.fidHasActive(FID1)).to.be.true;
    });

    it("reverts if FID already has active commitment", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).createCommitment(FID1, 0, 7, 1);
      await expect(pool.connect(user1).createCommitment(FID1, 0, 7, 1))
        .to.be.revertedWith("FID already has active commitment");
    });

    it("reverts for invalid tier index", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).createCommitment(FID1, 4, 7, 1))
        .to.be.revertedWith("Invalid tier index");
    });

    it("reverts if duration < 7 days", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).createCommitment(FID1, 0, 6, 1))
        .to.be.revertedWith("Duration must be 7-60 days");
    });

    it("reverts if duration > 60 days", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).createCommitment(FID1, 0, 61, 1))
        .to.be.revertedWith("Duration must be 7-60 days");
    });

    it("reverts if requiredProofs < 1 per week", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      // 14-day duration: minProofs = 2
      await expect(pool.connect(user1).createCommitment(FID1, 0, 14, 1))
        .to.be.revertedWith("Invalid proof count");
    });

    it("reverts if requiredProofs > 1 per day", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      // 7-day duration: maxProofs = 7
      await expect(pool.connect(user1).createCommitment(FID1, 0, 7, 8))
        .to.be.revertedWith("Invalid proof count");
    });

    it("reverts when paused", async function () {
      const { pool, admin, user1 } = await loadFixture(deployFixture);
      await pool.connect(admin).pause();
      await expect(pool.connect(user1).createCommitment(FID1, 0, 7, 1))
        .to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("accepts boundary values: 7-day / 1-proof and 60-day / 60-proofs", async function () {
      const { pool, user1, user2 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).createCommitment(FID1, 0, 7, 1)).to.not.be.reverted;
      await expect(pool.connect(user2).createCommitment(FID2, 0, 60, 60)).to.not.be.reverted;
    });
  });

  // ── recordProof ────────────────────────────────────────────────────────────
  describe("recordProof", function () {
    async function withActive(fixture) {
      await createBasicCommitment(fixture.pool, fixture.user1);
      return fixture;
    }

    it("increments verifiedProofs and emits ProofRecorded", async function () {
      const f = await loadFixture(deployFixture);
      const { pool, agentSigner } = await withActive(f);

      await expect(pool.connect(agentSigner).recordProof(0))
        .to.emit(pool, "ProofRecorded")
        .withArgs(0n, 1n);

      expect((await pool.commitments(0)).verifiedProofs).to.equal(1n);
    });

    it("allows multiple proofs up to the window", async function () {
      const f = await loadFixture(deployFixture);
      const { pool, user1, agentSigner } = f;
      await pool.connect(user1).createCommitment(FID1, 0, 7, 3);

      for (let i = 0; i < 3; i++) {
        await pool.connect(agentSigner).recordProof(0);
      }
      expect((await pool.commitments(0)).verifiedProofs).to.equal(3n);
    });

    it("reverts if called by non-agent", async function () {
      const f = await loadFixture(deployFixture);
      const { pool, stranger } = await withActive(f);
      await expect(pool.connect(stranger).recordProof(0))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("reverts if commitment is not Active", async function () {
      const f = await loadFixture(deployFixture);
      const { pool, agentSigner } = await withActive(f);
      const c = await pool.commitments(0);
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);
      // Now Passed — recordProof should revert
      await expect(pool.connect(agentSigner).recordProof(0))
        .to.be.revertedWith("Commitment not active");
    });

    it("reverts after endTime", async function () {
      const f = await loadFixture(deployFixture);
      const { pool, agentSigner } = await withActive(f);
      const c = await pool.commitments(0);
      await time.increaseTo(c.endTime + 1n);
      await expect(pool.connect(agentSigner).recordProof(0))
        .to.be.revertedWith("Commitment window closed");
    });
  });

  // ── resolveCommitment ──────────────────────────────────────────────────────
  describe("resolveCommitment", function () {
    it("marks commitment Passed when proofs met", async function () {
      const { pool, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      await pool.connect(agentSigner).recordProof(0);

      const c = await pool.commitments(0);
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);

      expect((await pool.commitments(0)).status).to.equal(1); // Passed
    });

    it("marks commitment Failed and adds to prizePool when proofs missed", async function () {
      const { pool, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      // no proofs recorded

      const c     = await pool.commitments(0);
      const before = await pool.prizePool();
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);

      expect((await pool.commitments(0)).status).to.equal(2); // Failed
      expect(await pool.prizePool()).to.equal(before + TIERS[0]);
    });

    it("emits CommitmentResolved", async function () {
      const { pool, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      const c = await pool.commitments(0);
      await time.increaseTo(c.endTime + 1n);

      await expect(pool.connect(agentSigner).resolveCommitment(0))
        .to.emit(pool, "CommitmentResolved")
        .withArgs(0n, 2n); // Failed (no proofs)
    });

    it("clears fidHasActive after resolution", async function () {
      const { pool, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      const c = await pool.commitments(0);
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);
      expect(await pool.fidHasActive(FID1)).to.be.false;
    });

    it("allows FID to create new commitment after resolution", async function () {
      const { pool, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      const c = await pool.commitments(0);
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);

      await expect(pool.connect(user1).createCommitment(FID1, 0, 7, 1)).to.not.be.reverted;
    });

    it("reverts before endTime", async function () {
      const { pool, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      await expect(pool.connect(agentSigner).resolveCommitment(0))
        .to.be.revertedWith("Commitment window not closed");
    });

    it("reverts if called by non-agent", async function () {
      const { pool, stranger, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      const c = await pool.commitments(0);
      await time.increaseTo(c.endTime + 1n);
      await expect(pool.connect(stranger).resolveCommitment(0))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("reverts if commitment is not Active", async function () {
      const { pool, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      const c = await pool.commitments(0);
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);
      await expect(pool.connect(agentSigner).resolveCommitment(0))
        .to.be.revertedWith("Commitment not active");
    });
  });

  // ── claim ──────────────────────────────────────────────────────────────────
  describe("claim", function () {
    // Set up: user1 passes a commitment, prizePool = 100k HIGHER
    async function passedCommitmentFixture() {
      const f = await deployFixture();
      const { pool, agentSigner, user1 } = f;
      await createBasicCommitment(pool, user1);
      await pool.connect(agentSigner).recordProof(0);
      const c = await pool.commitments(0);
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);
      return f;
    }

    it("pays out pledge − fee + bonus and updates accounting", async function () {
      const { pool, token, user1 } = await loadFixture(passedCommitmentFixture);

      // pledge=1000, fee=100, bonusCap=500, poolShare=2000 → bonus=500, payout=1400
      const pledge    = TIERS[0];               // 1 000 HIGHER
      const fee       = pledge * 10n / 100n;    //   100 HIGHER
      const bonusCap  = pledge * 50n / 100n;    //   500 HIGHER
      const poolShare = SEED * 2n / 100n;       // 2 000 HIGHER
      const bonus     = bonusCap < poolShare ? bonusCap : poolShare; // 500
      const payout    = pledge - fee + bonus;   // 1 400 HIGHER

      await expect(pool.connect(user1).claim(0))
        .to.changeTokenBalance(token, user1, payout);

      expect(await pool.accumulatedFees()).to.equal(fee);
      expect(await pool.prizePool()).to.equal(SEED - bonus);
    });

    it("emits CommitmentClaimed with correct values", async function () {
      const { pool, user1 } = await loadFixture(passedCommitmentFixture);
      const pledge   = TIERS[0];
      const fee      = pledge * 10n / 100n;
      const bonusCap = pledge * 50n / 100n;
      const bonus    = bonusCap < SEED * 2n / 100n ? bonusCap : SEED * 2n / 100n;
      const payout   = pledge - fee + bonus;

      await expect(pool.connect(user1).claim(0))
        .to.emit(pool, "CommitmentClaimed")
        .withArgs(0n, user1.address, payout, bonus, fee);
    });

    it("sets status to Claimed", async function () {
      const { pool, user1 } = await loadFixture(passedCommitmentFixture);
      await pool.connect(user1).claim(0);
      expect((await pool.commitments(0)).status).to.equal(3); // Claimed
    });

    it("reverts on double claim", async function () {
      const { pool, user1 } = await loadFixture(passedCommitmentFixture);
      await pool.connect(user1).claim(0);
      await expect(pool.connect(user1).claim(0))
        .to.be.revertedWith("Commitment not passed");
    });

    it("reverts if caller is not commitment owner", async function () {
      const { pool, stranger } = await loadFixture(passedCommitmentFixture);
      await expect(pool.connect(stranger).claim(0))
        .to.be.revertedWith("Not commitment owner");
    });

    it("reverts if commitment is Failed, not Passed", async function () {
      const { pool, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      // no proofs → will fail
      const c = await pool.commitments(0);
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);
      await expect(pool.connect(user1).claim(0))
        .to.be.revertedWith("Commitment not passed");
    });

    it("bonus is capped by prizePool * 2% when pool is small", async function () {
      // Drain prize pool so it's tiny, then check bonus = poolShare < bonusCap
      const { pool, token, admin, agentSigner, user1 } = await loadFixture(deployFixture);

      // Admin drains pool by seeding a second contract — instead, directly
      // test by creating a situation where prizePool < 50 * pledge.
      // We'll use a fresh deployment with a tiny seed (100 HIGHER).
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const t2 = await MockERC20.deploy("H", "H");
      const Pool = await ethers.getContractFactory("HigherCommitmentPool");
      const pool2 = await Pool.deploy(
        await t2.getAddress(),
        admin.address,
        agentSigner.address
      );
      const p2 = await pool2.getAddress();

      await t2.mint(admin.address, T(200_000));
      await t2.mint(user1.address, T(10_000));
      await t2.connect(admin).approve(p2, ethers.MaxUint256);
      await t2.connect(user1).approve(p2, ethers.MaxUint256);

      const tinyPool = T(50); // 50 HIGHER → poolShare = 1 HIGHER
      await pool2.connect(admin).seedPool(tinyPool);

      await pool2.connect(user1).createCommitment(FID1, 0, 7, 1);
      await pool2.connect(agentSigner).recordProof(0);
      const c = await pool2.commitments(0);
      await resolveAfterEnd(pool2, agentSigner, 0, c.endTime);

      const pledge    = TIERS[0];              // 1 000 HIGHER
      const fee       = pledge * 10n / 100n;   //   100 HIGHER
      const poolShare = tinyPool * 2n / 100n;  //     1 HIGHER (integer div)
      const payout    = pledge - fee + poolShare;

      await expect(pool2.connect(user1).claim(0))
        .to.changeTokenBalance(t2, user1, payout);
    });

    it("claim still works when contract is paused", async function () {
      const f = await loadFixture(passedCommitmentFixture);
      const { pool, admin, user1 } = f;
      await pool.connect(admin).pause();
      await expect(pool.connect(user1).claim(0)).to.not.be.reverted;
    });
  });

  // ── updateAgent ────────────────────────────────────────────────────────────
  describe("updateAgent", function () {
    it("grants AGENT_ROLE to new agent and revokes from old", async function () {
      const { pool, admin, agentSigner, stranger } = await loadFixture(deployFixture);
      await pool.connect(admin).updateAgent(stranger.address);

      expect(await pool.hasRole(AGENT_ROLE, stranger.address)).to.be.true;
      expect(await pool.hasRole(AGENT_ROLE, agentSigner.address)).to.be.false;
      expect(await pool.agent()).to.equal(stranger.address);
    });

    it("emits AgentUpdated", async function () {
      const { pool, admin, agentSigner, stranger } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).updateAgent(stranger.address))
        .to.emit(pool, "AgentUpdated")
        .withArgs(agentSigner.address, stranger.address);
    });

    it("allows zero address to just remove the agent", async function () {
      const { pool, admin, agentSigner } = await loadFixture(deployFixture);
      await pool.connect(admin).updateAgent(ethers.ZeroAddress);
      expect(await pool.hasRole(AGENT_ROLE, agentSigner.address)).to.be.false;
      expect(await pool.agent()).to.equal(ethers.ZeroAddress);
    });

    it("reverts for non-admin", async function () {
      const { pool, stranger } = await loadFixture(deployFixture);
      await expect(pool.connect(stranger).updateAgent(stranger.address))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // ── withdrawFees ───────────────────────────────────────────────────────────
  describe("withdrawFees", function () {
    async function withFees() {
      const f = await deployFixture();
      const { pool, agentSigner, user1 } = f;
      await createBasicCommitment(pool, user1);
      await pool.connect(agentSigner).recordProof(0);
      const c = await pool.commitments(0);
      await resolveAfterEnd(pool, agentSigner, 0, c.endTime);
      await pool.connect(user1).claim(0); // generates 100 HIGHER in fees
      return f;
    }

    it("transfers fees to feeRecipient and resets counter", async function () {
      const { pool, token, admin, feeRecipient } = await loadFixture(withFees);
      const fee = TIERS[0] * 10n / 100n; // 100 HIGHER

      await expect(pool.connect(admin).withdrawFees())
        .to.changeTokenBalance(token, feeRecipient, fee);

      expect(await pool.accumulatedFees()).to.equal(0n);
    });

    it("emits FeesWithdrawn", async function () {
      const { pool, admin, feeRecipient } = await loadFixture(withFees);
      const fee = TIERS[0] * 10n / 100n;
      await expect(pool.connect(admin).withdrawFees())
        .to.emit(pool, "FeesWithdrawn")
        .withArgs(feeRecipient.address, fee);
    });

    it("reverts if no fees have accumulated", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).withdrawFees())
        .to.be.revertedWith("No fees to withdraw");
    });

    it("reverts for non-admin", async function () {
      const { pool, stranger } = await loadFixture(withFees);
      await expect(pool.connect(stranger).withdrawFees())
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // ── pause / unpause ────────────────────────────────────────────────────────
  describe("pause / unpause", function () {
    it("admin can pause and unpause", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await pool.connect(admin).pause();
      expect(await pool.paused()).to.be.true;
      await pool.connect(admin).unpause();
      expect(await pool.paused()).to.be.false;
    });

    it("reverts pause for non-admin", async function () {
      const { pool, stranger } = await loadFixture(deployFixture);
      await expect(pool.connect(stranger).pause())
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("blocks createCommitment when paused but allows resolveCommitment", async function () {
      const { pool, admin, agentSigner, user1 } = await loadFixture(deployFixture);
      await createBasicCommitment(pool, user1);
      const c = await pool.commitments(0);
      await time.increaseTo(c.endTime + 1n);

      await pool.connect(admin).pause();

      // createCommitment blocked
      await expect(pool.connect(user1).createCommitment(FID2, 0, 7, 1))
        .to.be.revertedWithCustomError(pool, "EnforcedPause");

      // resolve still works
      await expect(pool.connect(agentSigner).resolveCommitment(0)).to.not.be.reverted;
    });
  });
});

// ─── chai helper for "any value" in event args ───────────────────────────────
function anyValue() { return true; }
