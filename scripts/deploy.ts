/**
 * Deploy HigherCommitmentPool and seed the prize pool.
 *
 * Prerequisites:
 *   npx hardhat compile          ← generates artifacts/
 *   Set env vars in .env         ← see .env.example
 *   Deployer wallet must hold ≥ SEED_AMOUNT $HIGHER tokens
 *
 * Usage:
 *   # Testnet
 *   CHAIN_ID=84532 npx tsx scripts/deploy.ts
 *
 *   # Mainnet
 *   CHAIN_ID=8453 npx tsx scripts/deploy.ts
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join }         from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia }   from 'viem/chains';

// ─── Config ───────────────────────────────────────────────────────────────────

const SEED_AMOUNT = parseUnits('100000', 18); // 100 000 $HIGHER

const CHAIN_ID           = Number(process.env.CHAIN_ID ?? 8453);
const CHAIN              = CHAIN_ID === 84532 ? baseSepolia : base;
const RPC_URL            = CHAIN_ID === 84532
  ? (process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org')
  : (process.env.BASE_RPC_URL         ?? 'https://mainnet.base.org');

const HIGHER_TOKEN       = (process.env.HIGHER_TOKEN_ADDRESS ?? '') as Address;
const CONTRACT_ADDRESS_NOT_USED = ''; // will be set after deploy

// ─── Wallet setup ─────────────────────────────────────────────────────────────

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

// Agent address: use AGENT_ADDRESS if set, otherwise derive from AGENT_PRIVATE_KEY
const agentAddress: Address = (() => {
  if (process.env.AGENT_ADDRESS) return process.env.AGENT_ADDRESS as Address;
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error('Set AGENT_ADDRESS or AGENT_PRIVATE_KEY');
  return privateKeyToAccount(toHex(key)).address;
})();

// Fee recipient: defaults to deployer
const feeRecipient: Address = (process.env.FEE_RECIPIENT as Address | undefined)
  ?? deployerAcct.address;

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

const POOL_READ_ABI = [
  {
    type: 'function', name: 'hasRole', stateMutability: 'view',
    inputs:  [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function', name: 'prizePool', stateMutability: 'view',
    inputs:  [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'seedPool', stateMutability: 'nonpayable',
    inputs:  [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
] as const;

const AGENT_ROLE = keccak256(toBytes('AGENT_ROLE'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadArtifact(): { abi: unknown[]; bytecode: Hex } {
  const artifactPath = join(
    process.cwd(),
    'artifacts/contracts/HigherCommitmentPool.sol/HigherCommitmentPool.json',
  );
  try {
    const raw = JSON.parse(readFileSync(artifactPath, 'utf8'));
    return { abi: raw.abi, bytecode: raw.bytecode };
  } catch {
    throw new Error(
      'Artifact not found. Run `npx hardhat compile` first.',
    );
  }
}

async function waitFor(hash: Hex, label: string) {
  process.stdout.write(`  ${label} (${hash.slice(0, 10)}…) `);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n── Higher Athletics Deploy ──────────────────────────`);
  console.log(`network:       ${CHAIN.name} (${CHAIN_ID})`);
  console.log(`deployer:      ${deployerAcct.address}`);
  console.log(`agent:         ${agentAddress}`);
  console.log(`fee recipient: ${feeRecipient}`);
  console.log(`higher token:  ${HIGHER_TOKEN}`);
  console.log(`seed amount:   ${formatUnits(SEED_AMOUNT, 18)} $HIGHER`);
  console.log(`─────────────────────────────────────────────────────\n`);

  if (!HIGHER_TOKEN) throw new Error('HIGHER_TOKEN_ADDRESS is not set');

  // 1. Deploy ─────────────────────────────────────────────────────────────────

  console.log('1. Deploying HigherCommitmentPool…');
  const { abi, bytecode } = loadArtifact();

  const deployHash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [HIGHER_TOKEN, feeRecipient, agentAddress],
  });

  const deployReceipt = await waitFor(deployHash, 'deploy tx');
  const contractAddress = deployReceipt.contractAddress;

  if (!contractAddress) throw new Error('Deploy receipt missing contractAddress');

  console.log(`\n  CONTRACT_ADDRESS=${contractAddress}\n`);

  // 2. Verify AGENT_ROLE ──────────────────────────────────────────────────────

  console.log('2. Verifying AGENT_ROLE…');
  const hasRole = await publicClient.readContract({
    address: contractAddress,
    abi:     POOL_READ_ABI,
    functionName: 'hasRole',
    args:    [AGENT_ROLE, agentAddress],
  });

  if (!hasRole) {
    throw new Error(`AGENT_ROLE not set on ${agentAddress} — check constructor args`);
  }
  console.log(`  ✓ AGENT_ROLE granted to ${agentAddress}`);

  // 3. Approve token transfer ─────────────────────────────────────────────────

  console.log('\n3. Approving contract to spend $HIGHER…');

  const deployerBalance = await publicClient.readContract({
    address: HIGHER_TOKEN,
    abi:     ERC20_ABI,
    functionName: 'balanceOf',
    args:    [deployerAcct.address],
  });

  console.log(`  deployer balance: ${formatUnits(deployerBalance, 18)} $HIGHER`);

  if (deployerBalance < SEED_AMOUNT) {
    throw new Error(
      `Insufficient balance: need ${formatUnits(SEED_AMOUNT, 18)}, have ${formatUnits(deployerBalance, 18)}`,
    );
  }

  const approveHash = await walletClient.writeContract({
    address:      HIGHER_TOKEN,
    abi:          ERC20_ABI,
    functionName: 'approve',
    args:         [contractAddress, SEED_AMOUNT],
  });
  await waitFor(approveHash, 'approve tx');

  // 4. Seed the pool ──────────────────────────────────────────────────────────

  console.log('\n4. Seeding prize pool…');

  const seedHash = await walletClient.writeContract({
    address:      contractAddress,
    abi:          POOL_READ_ABI,
    functionName: 'seedPool',
    args:         [SEED_AMOUNT],
  });
  await waitFor(seedHash, 'seedPool tx');

  const poolBalance = await publicClient.readContract({
    address:      contractAddress,
    abi:          POOL_READ_ABI,
    functionName: 'prizePool',
  });
  console.log(`  pool balance: ${formatUnits(poolBalance, 18)} $HIGHER`);

  // 5. Summary ────────────────────────────────────────────────────────────────

  console.log('\n─────────────────────────────────────────────────────');
  console.log('deployment complete.\n');
  console.log(`add to your .env:\n`);
  console.log(`  CONTRACT_ADDRESS=${contractAddress}`);
  console.log(`  HIGHER_TOKEN_ADDRESS=${HIGHER_TOKEN}`);
  console.log('─────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('\nDeploy failed:', err.message);
  process.exit(1);
});
