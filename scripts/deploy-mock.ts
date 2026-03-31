/**
 * Deploy MockERC20 to Base Sepolia (testnet only).
 *
 * Prerequisites:
 *   npx hardhat compile
 *   Set DEPLOYER_PRIVATE_KEY in .env
 *
 * Usage:
 *   npx tsx scripts/deploy-mock.ts
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join }         from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia }         from 'viem/chains';

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';

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

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const walletClient = createWalletClient({
  account:   deployerAcct,
  chain:     baseSepolia,
  transport: http(RPC_URL),
});

function loadArtifact(): { abi: unknown[]; bytecode: Hex } {
  const artifactPath = join(
    process.cwd(),
    'artifacts/contracts/mocks/MockERC20.sol/MockERC20.json',
  );
  try {
    const raw = JSON.parse(readFileSync(artifactPath, 'utf8'));
    return { abi: raw.abi, bytecode: raw.bytecode };
  } catch {
    throw new Error('Artifact not found. Run `npx hardhat compile` first.');
  }
}

async function main() {
  console.log('\n── MockERC20 Deploy (Base Sepolia) ──────────────────');
  console.log(`deployer: ${deployerAcct.address}`);
  console.log('─────────────────────────────────────────────────────\n');

  const { abi, bytecode } = loadArtifact();

  console.log('Deploying MockERC20 ("Mock Higher", "HIGHER")…');
  const deployHash = await walletClient.deployContract({
    abi,
    bytecode,
    args: ['Mock Higher', 'HIGHER'],
  });

  process.stdout.write(`  tx ${deployHash.slice(0, 10)}… `);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  console.log(`confirmed in block ${receipt.blockNumber}`);

  const contractAddress = receipt.contractAddress;
  if (!contractAddress) throw new Error('Deploy receipt missing contractAddress');

  console.log('\n─────────────────────────────────────────────────────');
  console.log('MockERC20 deployed.\n');
  console.log(`Add to your .env:\n`);
  console.log(`  HIGHER_TOKEN_ADDRESS=${contractAddress}`);
  console.log('─────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('\nDeploy failed:', err.message);
  process.exit(1);
});
