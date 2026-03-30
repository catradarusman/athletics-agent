/**
 * Seed the prize pool with $HIGHER tokens.
 *
 * Can be run at any point after deployment to top up the pool.
 * The deployer wallet must hold AGENT_AMOUNT $HIGHER and have DEFAULT_ADMIN_ROLE.
 *
 * Usage:
 *   # Default: 100 000 $HIGHER
 *   npx tsx scripts/seed-pool.ts
 *
 *   # Custom amount (whole tokens)
 *   SEED_AMOUNT=50000 npx tsx scripts/seed-pool.ts
 */

import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia }   from 'viem/chains';

// ─── Config ───────────────────────────────────────────────────────────────────

const CHAIN_ID       = Number(process.env.CHAIN_ID ?? 8453);
const CHAIN          = CHAIN_ID === 84532 ? baseSepolia : base;
const RPC_URL        = CHAIN_ID === 84532
  ? (process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org')
  : (process.env.BASE_RPC_URL         ?? 'https://mainnet.base.org');

const SEED_WHOLE     = process.env.SEED_AMOUNT ?? '100000';
const SEED_AMOUNT    = parseUnits(SEED_WHOLE, 18);

// ─── Wallet setup ─────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}`);
  return val;
}

function toHex(key: string): Hex {
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

const deployerKey    = toHex(requireEnv('DEPLOYER_PRIVATE_KEY'));
const deployerAcct   = privateKeyToAccount(deployerKey);
const contractAddr   = requireEnv('CONTRACT_ADDRESS') as Address;
const tokenAddr      = requireEnv('HIGHER_TOKEN_ADDRESS') as Address;

// ─── Clients ──────────────────────────────────────────────────────────────────

const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
const walletClient = createWalletClient({
  account:   deployerAcct,
  chain:     CHAIN,
  transport: http(RPC_URL),
});

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs:  [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const POOL_ABI = [
  {
    type: 'function', name: 'seedPool', stateMutability: 'nonpayable',
    inputs:  [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function', name: 'prizePool', stateMutability: 'view',
    inputs:  [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor(hash: Hex, label: string) {
  process.stdout.write(`  ${label} (${hash.slice(0, 10)}…) `);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n── Seed Pool ────────────────────────────────────────`);
  console.log(`network:   ${CHAIN.name} (${CHAIN_ID})`);
  console.log(`deployer:  ${deployerAcct.address}`);
  console.log(`contract:  ${contractAddr}`);
  console.log(`amount:    ${SEED_WHOLE} $HIGHER`);
  console.log(`────────────────────────────────────────────────────\n`);

  // Check deployer balance
  const balance = await publicClient.readContract({
    address:      tokenAddr,
    abi:          ERC20_ABI,
    functionName: 'balanceOf',
    args:         [deployerAcct.address],
  });

  console.log(`deployer balance: ${formatUnits(balance, 18)} $HIGHER`);

  if (balance < SEED_AMOUNT) {
    throw new Error(
      `Insufficient balance: need ${SEED_WHOLE}, have ${formatUnits(balance, 18)}`,
    );
  }

  const poolBefore = await publicClient.readContract({
    address:      contractAddr,
    abi:          POOL_ABI,
    functionName: 'prizePool',
  });
  console.log(`pool before:      ${formatUnits(poolBefore, 18)} $HIGHER\n`);

  // Approve
  console.log('1. Approving token transfer…');
  const approveHash = await walletClient.writeContract({
    address:      tokenAddr,
    abi:          ERC20_ABI,
    functionName: 'approve',
    args:         [contractAddr, SEED_AMOUNT],
  });
  await waitFor(approveHash, 'approve tx');

  // Seed
  console.log('\n2. Seeding pool…');
  const seedHash = await walletClient.writeContract({
    address:      contractAddr,
    abi:          POOL_ABI,
    functionName: 'seedPool',
    args:         [SEED_AMOUNT],
  });
  await waitFor(seedHash, 'seedPool tx');

  const poolAfter = await publicClient.readContract({
    address:      contractAddr,
    abi:          POOL_ABI,
    functionName: 'prizePool',
  });

  console.log(`\npool after: ${formatUnits(poolAfter, 18)} $HIGHER`);
  console.log('done.\n');
}

main().catch(err => {
  console.error('\nSeed failed:', err.message);
  process.exit(1);
});
