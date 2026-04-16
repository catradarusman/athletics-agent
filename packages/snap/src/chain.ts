import { createPublicClient, http, encodeFunctionData } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Address, Hex } from "viem";

// ─── Minimal ABI (only what the snap needs) ───────────────────────────────────

export const POOL_ABI = [
  {
    type: "function",
    name: "fidHasActive",
    stateMutability: "view",
    inputs: [{ name: "fid", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "fidActiveId",
    stateMutability: "view",
    inputs: [{ name: "fid", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "commitments",
    stateMutability: "view",
    inputs: [{ name: "commitmentId", type: "uint256" }],
    outputs: [
      { name: "user", type: "address" },
      { name: "fid", type: "uint256" },
      { name: "pledgeAmount", type: "uint256" },
      { name: "startTime", type: "uint256" },
      { name: "endTime", type: "uint256" },
      { name: "requiredProofs", type: "uint256" },
      { name: "verifiedProofs", type: "uint256" },
      { name: "status", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "prizePool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "createCommitment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "fid", type: "uint256" },
      { name: "tierIndex", type: "uint256" },
      { name: "durationDays", type: "uint256" },
      { name: "requiredProofs", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "commitmentId", type: "uint256" }],
    outputs: [],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

// ─── Config helpers ───────────────────────────────────────────────────────────

function getChain() {
  return Number(process.env.CHAIN_ID ?? 8453) === 84532 ? baseSepolia : base;
}

export function getContractAddress(): Address {
  const addr = process.env.CONTRACT_ADDRESS;
  if (!addr) throw new Error("CONTRACT_ADDRESS not set");
  return addr as Address;
}

export function getTokenAddress(): Address {
  return (
    process.env.HIGHER_TOKEN_ADDRESS ??
    "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe"
  ) as Address;
}

let _client: ReturnType<typeof createPublicClient> | null = null;

function getClient() {
  if (!_client) {
    _client = createPublicClient({
      chain: getChain(),
      transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
    }) as ReturnType<typeof createPublicClient>;
  }
  return _client;
}

// ─── Read functions ───────────────────────────────────────────────────────────

export async function fidHasActive(fid: number): Promise<boolean> {
  const client = getClient();
  return client.readContract({
    address: getContractAddress(),
    abi: POOL_ABI,
    functionName: "fidHasActive",
    args: [BigInt(fid)],
  }) as Promise<boolean>;
}

export async function fidActiveId(fid: number): Promise<bigint> {
  const client = getClient();
  return client.readContract({
    address: getContractAddress(),
    abi: POOL_ABI,
    functionName: "fidActiveId",
    args: [BigInt(fid)],
  }) as Promise<bigint>;
}

export interface ChainCommitment {
  user: Address;
  fid: bigint;
  pledgeAmount: bigint;
  startTime: Date;
  endTime: Date;
  requiredProofs: number;
  verifiedProofs: number;
  /** 0=Active 1=Passed 2=Failed 3=Claimed */
  status: number;
}

export async function getCommitment(
  commitmentId: bigint
): Promise<ChainCommitment> {
  const client = getClient();
  const raw = (await client.readContract({
    address: getContractAddress(),
    abi: POOL_ABI,
    functionName: "commitments",
    args: [commitmentId],
  })) as readonly [
    Address,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    number
  ];
  return {
    user: raw[0],
    fid: raw[1],
    pledgeAmount: raw[2],
    startTime: new Date(Number(raw[3]) * 1_000),
    endTime: new Date(Number(raw[4]) * 1_000),
    requiredProofs: Number(raw[5]),
    verifiedProofs: Number(raw[6]),
    status: Number(raw[7]),
  };
}

export async function getPoolBalance(): Promise<bigint> {
  const client = getClient();
  return client.readContract({
    address: getContractAddress(),
    abi: POOL_ABI,
    functionName: "prizePool",
  }) as Promise<bigint>;
}

// ─── Calldata encoders (server-side, passed to signing mini app) ──────────────

/** Encode ERC-20 approve(pool, amount) calldata. amount is in whole tokens. */
export function encodeApproveData(wholeTokens: number): Hex {
  const amount = BigInt(wholeTokens) * BigInt(10 ** 18);
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [getContractAddress(), amount],
  });
}

/** Encode createCommitment calldata for the given params. */
export function encodeCreateCommitmentData(
  fid: number,
  tierIndex: number,
  durationDays: number,
  requiredProofs: number
): Hex {
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: "createCommitment",
    args: [
      BigInt(fid),
      BigInt(tierIndex),
      BigInt(durationDays),
      BigInt(requiredProofs),
    ],
  });
}

/** Encode claim(commitmentId) calldata. */
export function encodeClaimData(commitmentId: number): Hex {
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: "claim",
    args: [BigInt(commitmentId)],
  });
}
