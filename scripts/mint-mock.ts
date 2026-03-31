/**
 * Mint MockERC20 tokens to a recipient (testnet only).
 *
 * Prerequisites:
 *   HIGHER_TOKEN_ADDRESS must point to a deployed MockERC20
 *   DEPLOYER_PRIVATE_KEY set in .env
 *
 * Usage:
 *   # Mint 100 000 HIGHER to deployer (default)
 *   npx tsx scripts/mint-mock.ts
 *
 *   # Mint custom amount to custom address
 *   MINT_TO=0xABC... MINT_AMOUNT=50000 npx tsx scripts/mint-mock.ts
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
import { baseSepolia }         from 'viem/chains';

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL     = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const MINT_WHOLE  = process.env.MINT_AMOUNT ?? '100000';
const MINT_AMOUNT = parseUnits(MINT_WHOLE, 18);

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}`);
  return val;
}

function toHex(key: string): Hex {
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

const deployerKey  = toHex(requireEnv('DEPLOYER_PRIVATE_KEY'));
const deployerAcct = privateKeyToAccount(deployerKey);
const tokenAddr    = requireEnv('HIGHER_TOKEN_ADDRESS') as Address;
const mintTo       = (process.env.MINT_TO ?? deployerAcct.address) as Address;

// ─── Clients ──────────────────────────────────────────────────────────────────

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const walletClient = createWalletClient({
  account:   deployerAcct,
  chain:     baseSepolia,
  transport: http(RPC_URL),
});

// ─── ABI ──────────────────────────────────────────────────────────────────────

const MOCK_ERC20_ABI = [
  {
    type: 'function', name: 'mint', stateMutability: 'nonpayable',
    inputs:  [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'symbol', stateMutability: 'view',
    inputs:  [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const symbol = await publicClient.readContract({
    address: tokenAddr, abi: MOCK_ERC20_ABI, functionName: 'symbol',
  });

  console.log('\n── Mint Mock Tokens (Base Sepolia) ──────────────────');
  console.log(`token:    ${tokenAddr} ($${symbol})`);
  console.log(`mint to:  ${mintTo}`);
  console.log(`amount:   ${MINT_WHOLE} $${symbol}`);
  console.log('─────────────────────────────────────────────────────\n');

  const balanceBefore = await publicClient.readContract({
    address: tokenAddr, abi: MOCK_ERC20_ABI, functionName: 'balanceOf', args: [mintTo],
  });
  console.log(`balance before: ${formatUnits(balanceBefore, 18)} $${symbol}`);

  const hash = await walletClient.writeContract({
    address:      tokenAddr,
    abi:          MOCK_ERC20_ABI,
    functionName: 'mint',
    args:         [mintTo, MINT_AMOUNT],
  });

  process.stdout.write(`  mint tx (${hash.slice(0, 10)}…) `);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`confirmed in block ${receipt.blockNumber}`);

  const balanceAfter = await publicClient.readContract({
    address: tokenAddr, abi: MOCK_ERC20_ABI, functionName: 'balanceOf', args: [mintTo],
  });
  console.log(`balance after:  ${formatUnits(balanceAfter, 18)} $${symbol}`);
  console.log('\ndone.\n');
}

main().catch(err => {
  console.error('\nMint failed:', err.message);
  process.exit(1);
});
