/**
 * Rotate the agent wallet — revokes AGENT_ROLE from the current agent
 * and grants it to a new address.
 *
 * Requires DEFAULT_ADMIN_ROLE (deployer wallet).
 * The new agent wallet must be pre-funded with ETH for gas before going live.
 *
 * Usage:
 *   # Set new address directly
 *   NEW_AGENT_ADDRESS=0x… npx tsx scripts/update-agent.ts
 *
 *   # Derive new address from a private key
 *   NEW_AGENT_PRIVATE_KEY=0x… npx tsx scripts/update-agent.ts
 *
 *   # Remove agent entirely (emergency pause of agent writes)
 *   REMOVE_AGENT=true npx tsx scripts/update-agent.ts
 */

import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia }   from 'viem/chains';

// ─── Config ───────────────────────────────────────────────────────────────────

const CHAIN_ID     = Number(process.env.CHAIN_ID ?? 8453);
const CHAIN        = CHAIN_ID === 84532 ? baseSepolia : base;
const RPC_URL      = CHAIN_ID === 84532
  ? (process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org')
  : (process.env.BASE_RPC_URL         ?? 'https://mainnet.base.org');

// ─── Wallet setup ─────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}`);
  return val;
}

function toHex(key: string): Hex {
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

const adminKey    = toHex(requireEnv('DEPLOYER_PRIVATE_KEY'));
const adminAcct   = privateKeyToAccount(adminKey);
const contractAddr = requireEnv('CONTRACT_ADDRESS') as Address;

// Resolve new agent address
const newAgentAddress: Address = (() => {
  if (process.env.REMOVE_AGENT === 'true') return zeroAddress;
  if (process.env.NEW_AGENT_ADDRESS) return process.env.NEW_AGENT_ADDRESS as Address;
  if (process.env.NEW_AGENT_PRIVATE_KEY) {
    return privateKeyToAccount(toHex(process.env.NEW_AGENT_PRIVATE_KEY)).address;
  }
  throw new Error('Set NEW_AGENT_ADDRESS, NEW_AGENT_PRIVATE_KEY, or REMOVE_AGENT=true');
})();

// ─── Clients ──────────────────────────────────────────────────────────────────

const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
const walletClient = createWalletClient({
  account:   adminAcct,
  chain:     CHAIN,
  transport: http(RPC_URL),
});

// ─── ABI ──────────────────────────────────────────────────────────────────────

const AGENT_ROLE = keccak256(toBytes('AGENT_ROLE'));

const POOL_ABI = [
  {
    type: 'function', name: 'updateAgent', stateMutability: 'nonpayable',
    inputs:  [{ name: 'newAgent', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function', name: 'agent', stateMutability: 'view',
    inputs:  [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function', name: 'hasRole', stateMutability: 'view',
    inputs:  [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
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
  const currentAgent = await publicClient.readContract({
    address:      contractAddr,
    abi:          POOL_ABI,
    functionName: 'agent',
  });

  const removing = newAgentAddress === zeroAddress;

  console.log(`\n── Update Agent ─────────────────────────────────────`);
  console.log(`network:       ${CHAIN.name} (${CHAIN_ID})`);
  console.log(`admin:         ${adminAcct.address}`);
  console.log(`contract:      ${contractAddr}`);
  console.log(`current agent: ${currentAgent}`);
  console.log(`new agent:     ${removing ? '(removing)' : newAgentAddress}`);
  console.log(`─────────────────────────────────────────────────────\n`);

  if (currentAgent.toLowerCase() === newAgentAddress.toLowerCase() && !removing) {
    console.log('new agent matches current agent — nothing to do.');
    return;
  }

  // Confirm admin has the admin role before sending any tx
  const isAdmin = await publicClient.readContract({
    address:      contractAddr,
    abi:          POOL_ABI,
    functionName: 'hasRole',
    args:         ['0x0000000000000000000000000000000000000000000000000000000000000000', adminAcct.address],
  });
  if (!isAdmin) throw new Error(`${adminAcct.address} does not hold DEFAULT_ADMIN_ROLE`);

  // Execute updateAgent
  const hash = await walletClient.writeContract({
    address:      contractAddr,
    abi:          POOL_ABI,
    functionName: 'updateAgent',
    args:         [newAgentAddress],
  });
  await waitFor(hash, 'updateAgent tx');

  // Verify
  const updatedAgent = await publicClient.readContract({
    address:      contractAddr,
    abi:          POOL_ABI,
    functionName: 'agent',
  });

  if (!removing) {
    const roleGranted = await publicClient.readContract({
      address:      contractAddr,
      abi:          POOL_ABI,
      functionName: 'hasRole',
      args:         [AGENT_ROLE, newAgentAddress],
    });
    if (!roleGranted) throw new Error('AGENT_ROLE not reflected after updateAgent');
  }

  console.log(`\nagent updated: ${updatedAgent}`);

  if (!removing) {
    console.log(`\nremember to:`);
    console.log(`  1. update AGENT_PRIVATE_KEY in your deployment environment`);
    console.log(`  2. ensure the new agent wallet has ETH for gas`);
    console.log(`  3. restart the agent server with the new key`);
  }

  console.log('done.\n');
}

main().catch(err => {
  console.error('\nUpdate failed:', err.message);
  process.exit(1);
});
