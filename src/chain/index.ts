import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
} from 'viem';
import type { Hash, Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

// ─── ABI ─────────────────────────────────────────────────────────────────────
// Defined inline rather than imported from Hardhat artifacts so this module
// works before `npx hardhat compile` has been run. Keep in sync with
// contracts/HigherCommitmentPool.sol.
//
// NOTE on commitments() output format: Solidity exposes public mappings with
// struct values as getters whose ABI outputs are the individual struct fields
// (not a tuple wrapper). viem returns them as a named-key object when all
// outputs are named and there is more than one.

export const POOL_ABI = [
  // ── Write: user ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'createCommitment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'fid',            type: 'uint256' },
      { name: 'tierIndex',      type: 'uint256' },
      { name: 'durationDays',   type: 'uint256' },
      { name: 'requiredProofs', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'commitmentId', type: 'uint256' }],
    outputs: [],
  },
  // ── Write: agent ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'recordProof',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'commitmentId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'resolveCommitment',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'commitmentId', type: 'uint256' }],
    outputs: [],
  },
  // ── Write: admin ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'seedPool',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  // ── Read ───────────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'prizePool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'accumulatedFees',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nextCommitmentId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    // Public mapping getter — returns individual named fields (not a tuple).
    // viem decodes multiple named outputs as a keyed object.
    type: 'function',
    name: 'commitments',
    stateMutability: 'view',
    inputs: [{ name: 'commitmentId', type: 'uint256' }],
    outputs: [
      { name: 'user',           type: 'address' },
      { name: 'fid',            type: 'uint256' },
      { name: 'pledgeAmount',   type: 'uint256' },
      { name: 'startTime',      type: 'uint256' },
      { name: 'endTime',        type: 'uint256' },
      { name: 'requiredProofs', type: 'uint256' },
      { name: 'verifiedProofs', type: 'uint256' },
      { name: 'status',         type: 'uint8'   },
    ],
  },
  {
    type: 'function',
    name: 'PLEDGE_TIERS',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fidHasActive',
    stateMutability: 'view',
    inputs: [{ name: 'fid', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'fidActiveId',
    stateMutability: 'view',
    inputs: [{ name: 'fid', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── Events ─────────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'CommitmentCreated',
    inputs: [
      { indexed: true,  name: 'commitmentId',  type: 'uint256' },
      { indexed: true,  name: 'user',           type: 'address' },
      { indexed: false, name: 'fid',            type: 'uint256' },
      { indexed: false, name: 'pledgeAmount',   type: 'uint256' },
      { indexed: false, name: 'endTime',        type: 'uint256' },
      { indexed: false, name: 'requiredProofs', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'CommitmentResolved',
    inputs: [
      { indexed: true,  name: 'commitmentId', type: 'uint256' },
      { indexed: false, name: 'status',       type: 'uint8'   },
    ],
  },
  {
    type: 'event',
    name: 'ProofRecorded',
    inputs: [
      { indexed: true,  name: 'commitmentId',  type: 'uint256' },
      { indexed: false, name: 'verifiedProofs', type: 'uint256' },
    ],
  },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Maps the contract's Status enum (uint8) to a readable string. */
export type OnchainStatus = 'Active' | 'Passed' | 'Failed' | 'Claimed';

const STATUS_MAP: Record<number, OnchainStatus> = {
  0: 'Active',
  1: 'Passed',
  2: 'Failed',
  3: 'Claimed',
};

export interface OnchainCommitment {
  user:           Address;
  fid:            bigint;
  pledgeAmount:   bigint;   // raw wei (18 decimals)
  startTime:      Date;
  endTime:        Date;
  requiredProofs: bigint;
  verifiedProofs: bigint;
  status:         OnchainStatus;
}

/** Data returned to a mini app or frame to build the user-signed transaction. */
export interface CommitmentTxData {
  to:   Address;
  data: Hex;
}

// ─── Config helpers ───────────────────────────────────────────────────────────

function getChain() {
  // CHAIN_ID=84532 → Base Sepolia (testing); anything else → Base mainnet.
  return Number(process.env.CHAIN_ID ?? 8453) === 84532 ? baseSepolia : base;
}

function getRpcUrl(): string {
  const chain = getChain();
  if (chain.id === 84532) {
    return process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
  }
  return process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
}

function getContractAddress(): Address {
  const addr = process.env.CONTRACT_ADDRESS;
  if (!addr) throw new Error('CONTRACT_ADDRESS environment variable is not set');
  return addr as Address;
}

// ─── Client singletons ────────────────────────────────────────────────────────
// Clients are created lazily and cached. The wallet client is never created
// in code paths that only need reads — AGENT_PRIVATE_KEY stays unused there.

let _publicClient: ReturnType<typeof createPublicClient> | null = null;
let _walletClient: ReturnType<typeof createWalletClient> | null = null;

/**
 * Read-only viem client for Base (or Base Sepolia when CHAIN_ID=84532).
 * Safe to call without AGENT_PRIVATE_KEY.
 */
export function getPublicClient() {
  if (!_publicClient) {
    // Cast needed: Base/BaseSepolia are OP Stack chains whose `getBlock` return
    // type includes deposit transactions, which conflicts with the generic
    // ReturnType<typeof createPublicClient>.
    _publicClient = createPublicClient({
      chain: getChain(),
      transport: http(getRpcUrl()),
    }) as ReturnType<typeof createPublicClient>;
  }
  return _publicClient!;
}

/**
 * Wallet client using AGENT_PRIVATE_KEY. Used only for agent write calls.
 * Throws immediately if AGENT_PRIVATE_KEY is absent.
 */
export function getWalletClient() {
  if (!_walletClient) {
    const raw = process.env.AGENT_PRIVATE_KEY;
    if (!raw) throw new Error('AGENT_PRIVATE_KEY environment variable is not set');

    const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
    const account = privateKeyToAccount(hex);

    _walletClient = createWalletClient({
      account,
      chain: getChain(),
      transport: http(getRpcUrl()),
    });
  }
  return _walletClient!;
}

// ─── Transaction-data helper (user-facing) ────────────────────────────────────

/**
 * Encode the calldata for createCommitment so a mini app or Farcaster frame
 * can present the transaction to the user for signing. The agent does NOT
 * sign this — the user's own wallet does.
 *
 * @param fid            User's Farcaster ID
 * @param tierIndex      0 = Starter, 1 = Standard, 2 = Serious, 3 = All-in
 * @param durationDays   Commitment window length (7–60)
 * @param requiredProofs Number of proof casts required
 */
export function createCommitmentTxData(
  fid: bigint,
  tierIndex: bigint,
  durationDays: bigint,
  requiredProofs: bigint,
): CommitmentTxData {
  const data = encodeFunctionData({
    abi: POOL_ABI,
    functionName: 'createCommitment',
    args: [fid, tierIndex, durationDays, requiredProofs],
  });

  return {
    to:   getContractAddress(),
    data,
  };
}

// ─── Agent write functions ────────────────────────────────────────────────────

/**
 * Submit a verified proof-of-work cast to the contract.
 * Only callable by the agent wallet (AGENT_ROLE required onchain).
 * Returns the transaction hash; caller should wait for receipt if needed.
 */
export async function recordProofOnchain(commitmentId: bigint): Promise<Hash> {
  // Cast needed: module-level variable loses account/chain generics from
  // createWalletClient, so we assert to any to avoid spurious overload errors.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client  = getWalletClient() as any;
  const address = getContractAddress();

  return client.writeContract({
    address,
    abi:          POOL_ABI,
    functionName: 'recordProof',
    args:         [commitmentId],
  }) as Promise<Hash>;
}

/**
 * Settle a commitment after its window has closed.
 * Passed → user can claim; Failed → pledge forfeited to prize pool.
 * Only callable by the agent wallet (AGENT_ROLE required onchain).
 */
export async function resolveCommitmentOnchain(commitmentId: bigint): Promise<Hash> {
  // Cast needed: same reason as recordProofOnchain above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client  = getWalletClient() as any;
  const address = getContractAddress();

  return client.writeContract({
    address,
    abi:          POOL_ABI,
    functionName: 'resolveCommitment',
    args:         [commitmentId],
  }) as Promise<Hash>;
}

// ─── Read functions ───────────────────────────────────────────────────────────

/**
 * Whether the given FID currently has an active onchain commitment.
 */
export async function getFidHasActive(fid: bigint): Promise<boolean> {
  const client  = getPublicClient();
  const address = getContractAddress();
  return client.readContract({
    address,
    abi:          POOL_ABI,
    functionName: 'fidHasActive',
    args:         [fid],
  });
}

/**
 * Return the onchain commitment ID for a FID's current active commitment.
 * Only meaningful when getFidHasActive returns true.
 */
export async function getFidActiveId(fid: bigint): Promise<bigint> {
  const client  = getPublicClient();
  const address = getContractAddress();
  return client.readContract({
    address,
    abi:          POOL_ABI,
    functionName: 'fidActiveId',
    args:         [fid],
  });
}

/**
 * Read the current prize pool balance from the contract (raw wei, bigint).
 */
export async function getPoolBalance(): Promise<bigint> {
  const client  = getPublicClient();
  const address = getContractAddress();

  return client.readContract({
    address,
    abi:          POOL_ABI,
    functionName: 'prizePool',
  });
}

/**
 * Read the full onchain commitment struct for a given ID.
 * Timestamps are converted to JS Date objects; status uint8 mapped to a
 * readable string.
 */
export async function getCommitmentOnchain(
  commitmentId: bigint,
): Promise<OnchainCommitment> {
  const client  = getPublicClient();
  const address = getContractAddress();

  // viem decodes multiple named outputs as a named-key object.
  const raw = await client.readContract({
    address,
    abi:          POOL_ABI,
    functionName: 'commitments',
    args:         [commitmentId],
  });

  // viem v2 decodes multiple outputs as a readonly tuple (positional array).
  // Indices match the ABI outputs order: user, fid, pledgeAmount, startTime,
  // endTime, requiredProofs, verifiedProofs, status.
  return {
    user:           raw[0] as Address,
    fid:            raw[1] as bigint,
    pledgeAmount:   raw[2] as bigint,
    startTime:      new Date(Number(raw[3] as bigint) * 1_000),
    endTime:        new Date(Number(raw[4] as bigint) * 1_000),
    requiredProofs: raw[5] as bigint,
    verifiedProofs: raw[6] as bigint,
    status:         STATUS_MAP[raw[7] as number] ?? 'Active',
  };
}
