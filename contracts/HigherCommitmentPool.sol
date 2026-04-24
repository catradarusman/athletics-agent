// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title HigherCommitmentPool
 * @notice Holds $HIGHER token pledges for fitness commitments in the /higher-athletics
 *         Farcaster channel. An on-chain AI agent validates proof-of-work casts and
 *         releases funds accordingly.
 *
 * Flow:
 *   1. User calls createCommitment() — pledge locked in contract.
 *   2. Agent calls recordProof() each time a valid cast is verified.
 *   3. After endTime, agent calls resolveCommitment():
 *        - met proofs → Passed; pledge is claimable + bonus from prize pool.
 *        - missed proofs → Failed; pledge forfeited to prize pool.
 *   4. User calls claim() to receive pledge − fee + bonus.
 */
contract HigherCommitmentPool is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─── Roles ───────────────────────────────────────────────────────────────
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    // ─── Pledge tiers (18-decimal $HIGHER amounts) ───────────────────────────
    uint256[4] public PLEDGE_TIERS;

    // ─── State ───────────────────────────────────────────────────────────────
    IERC20 public immutable higherToken;
    address public feeRecipient;
    address public agent; // convenience view of current agent address

    uint256 public prizePool;         // tokens available for winner bonuses
    uint256 public accumulatedFees;   // 10 % fees pending withdrawal
    uint256 public nextCommitmentId;
    uint256 public poolShareBps = 200; // bonus = poolShareBps/10000 of prizePool (default 2%)

    // ─── Structs / enums ─────────────────────────────────────────────────────
    enum Status { Active, Passed, Failed, Claimed }

    struct Commitment {
        address user;
        uint256 fid;            // Farcaster ID
        uint256 pledgeAmount;
        uint256 startTime;
        uint256 endTime;
        uint256 requiredProofs;
        uint256 verifiedProofs;
        Status  status;
    }

    mapping(uint256 => Commitment) public commitments;  // commitmentId => Commitment
    mapping(uint256 => bool)       public fidHasActive; // fid => active flag
    mapping(uint256 => uint256)    public fidActiveId;  // fid => commitmentId

    // ─── Events ──────────────────────────────────────────────────────────────
    event CommitmentCreated(
        uint256 indexed commitmentId,
        address indexed user,
        uint256 fid,
        uint256 pledgeAmount,
        uint256 endTime,
        uint256 requiredProofs
    );
    event ProofRecorded(uint256 indexed commitmentId, uint256 verifiedProofs);
    event CommitmentResolved(uint256 indexed commitmentId, Status status);
    event CommitmentClaimed(
        uint256 indexed commitmentId,
        address indexed user,
        uint256 payout,
        uint256 bonus,
        uint256 fee
    );
    event PoolSeeded(address indexed seeder, uint256 amount);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event FeesWithdrawn(address indexed recipient, uint256 amount);

    // ─── Constructor ─────────────────────────────────────────────────────────
    constructor(
        address _higherToken,
        address _feeRecipient,
        address _agent
    ) {
        require(_higherToken   != address(0), "Zero token address");
        require(_feeRecipient  != address(0), "Zero fee recipient");
        require(_agent         != address(0), "Zero agent address");

        higherToken  = IERC20(_higherToken);
        feeRecipient = _feeRecipient;
        agent        = _agent;

        PLEDGE_TIERS[0] = 1_000 * 1e18;  // Starter
        PLEDGE_TIERS[1] = 5_000 * 1e18;  // Standard
        PLEDGE_TIERS[2] = 10_000 * 1e18; // Serious
        PLEDGE_TIERS[3] = 25_000 * 1e18; // All-in

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(AGENT_ROLE, _agent);
    }

    // ─── User functions ───────────────────────────────────────────────────────

    /**
     * @notice Lock a pledge and start a commitment period.
     * @param fid            Farcaster ID of the committing user.
     * @param tierIndex      0 = Starter (1 k), 1 = Standard (5 k),
     *                       2 = Serious (10 k), 3 = All-in (25 k).
     * @param durationDays   Length of commitment window (7–60 days).
     * @param requiredProofs Number of proof-of-work casts required
     *                       (≥ 1/week and ≤ 1/day relative to duration).
     */
    function createCommitment(
        uint256 fid,
        uint256 tierIndex,
        uint256 durationDays,
        uint256 requiredProofs
    ) external whenNotPaused nonReentrant {
        require(tierIndex < 4, "Invalid tier index");
        require(durationDays >= 7 && durationDays <= 60, "Duration must be 7-60 days");

        uint256 minProofs = durationDays / 7;   // at least 1 per week
        uint256 maxProofs = durationDays;        // at most 1 per day
        require(
            requiredProofs >= minProofs && requiredProofs <= maxProofs,
            "Invalid proof count"
        );
        require(!fidHasActive[fid], "FID already has active commitment");

        uint256 pledgeAmount = PLEDGE_TIERS[tierIndex];
        higherToken.safeTransferFrom(msg.sender, address(this), pledgeAmount);

        uint256 id        = nextCommitmentId++;
        uint256 startTime = block.timestamp;
        uint256 endTime   = startTime + durationDays * 1 days;

        commitments[id] = Commitment({
            user:           msg.sender,
            fid:            fid,
            pledgeAmount:   pledgeAmount,
            startTime:      startTime,
            endTime:        endTime,
            requiredProofs: requiredProofs,
            verifiedProofs: 0,
            status:         Status.Active
        });

        fidHasActive[fid] = true;
        fidActiveId[fid]  = id;

        emit CommitmentCreated(id, msg.sender, fid, pledgeAmount, endTime, requiredProofs);
    }

    /**
     * @notice Redeem a passed commitment for pledge − fee + bonus.
     * @param commitmentId The commitment to claim.
     */
    function claim(uint256 commitmentId) external nonReentrant {
        Commitment storage c = commitments[commitmentId];
        require(c.user   == msg.sender,       "Not commitment owner");
        require(c.status == Status.Passed,    "Commitment not passed");

        c.status = Status.Claimed;

        uint256 pledge    = c.pledgeAmount;
        uint256 fee       = pledge * 10 / 100;
        uint256 bonusCap  = pledge * 50 / 100;
        uint256 poolShare = prizePool * poolShareBps / 10_000;
        uint256 bonus     = bonusCap < poolShare ? bonusCap : poolShare;
        uint256 payout    = pledge - fee + bonus;

        accumulatedFees += fee;
        prizePool       -= bonus;

        higherToken.safeTransfer(msg.sender, payout);

        emit CommitmentClaimed(commitmentId, msg.sender, payout, bonus, fee);
    }

    // ─── Agent functions ──────────────────────────────────────────────────────

    /**
     * @notice Record a verified proof-of-work cast for an active commitment.
     * @param commitmentId The commitment receiving the proof.
     */
    function recordProof(uint256 commitmentId) external onlyRole(AGENT_ROLE) {
        Commitment storage c = commitments[commitmentId];
        require(c.status == Status.Active,        "Commitment not active");
        require(block.timestamp <= c.endTime,     "Commitment window closed");

        c.verifiedProofs++;
        emit ProofRecorded(commitmentId, c.verifiedProofs);
    }

    /**
     * @notice Settle a commitment after its window closes.
     *         Pass  → pledge is claimable by the user.
     *         Fail  → pledge is forfeited to the prize pool.
     * @param commitmentId The commitment to resolve.
     */
    function resolveCommitment(uint256 commitmentId) external onlyRole(AGENT_ROLE) {
        Commitment storage c = commitments[commitmentId];
        require(c.status == Status.Active,         "Commitment not active");
        require(block.timestamp > c.endTime,       "Commitment window not closed");

        fidHasActive[c.fid] = false;

        if (c.verifiedProofs >= c.requiredProofs) {
            c.status = Status.Passed;
        } else {
            c.status  = Status.Failed;
            prizePool += c.pledgeAmount;
        }

        emit CommitmentResolved(commitmentId, c.status);
    }

    // ─── Admin functions ──────────────────────────────────────────────────────

    /**
     * @notice Seed the prize pool. Admin must approve the token transfer first.
     * @param amount Amount of $HIGHER to add to the pool.
     */
    function seedPool(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(amount > 0, "Amount must be > 0");
        higherToken.safeTransferFrom(msg.sender, address(this), amount);
        prizePool += amount;
        emit PoolSeeded(msg.sender, amount);
    }

    /**
     * @notice Replace the current agent with a new one.
     * @param newAgent Address to grant AGENT_ROLE; zero address just removes the old agent.
     */
    function updateAgent(address newAgent) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldAgent = agent;
        if (oldAgent != address(0)) {
            _revokeRole(AGENT_ROLE, oldAgent);
        }
        agent = newAgent;
        if (newAgent != address(0)) {
            _grantRole(AGENT_ROLE, newAgent);
        }
        emit AgentUpdated(oldAgent, newAgent);
    }

    /**
     * @notice Transfer all accumulated protocol fees to feeRecipient.
     */
    function withdrawFees() external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        uint256 amount = accumulatedFees;
        require(amount > 0, "No fees to withdraw");
        accumulatedFees = 0;
        higherToken.safeTransfer(feeRecipient, amount);
        emit FeesWithdrawn(feeRecipient, amount);
    }

    /**
     * @notice Set the pool share per winner in basis points (100 = 1%, 200 = 2%, 500 = 5%).
     * @param bps New value; capped at 1000 (10%) to prevent pool drain in a single claim.
     */
    function setPoolShareBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps > 0 && bps <= 1000, "bps must be 1-1000");
        poolShareBps = bps;
    }

    /**
     * @notice Pause new commitments (resolve and claim remain open).
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Resume normal operation.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
