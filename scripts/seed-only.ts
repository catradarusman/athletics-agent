/**
 * Calls seedPool directly (no approve step) — use when allowance is already set.
 * Also waits for any pending transactions to clear first.
 */
import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const RPC_URL    = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const CONTRACT   = process.env.CONTRACT_ADDRESS as Address;
const AMOUNT     = parseUnits(process.env.SEED_AMOUNT ?? '100000', 18);

function toHex(key: string): Hex {
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

const acct = privateKeyToAccount(toHex(process.env.DEPLOYER_PRIVATE_KEY!));
const pc   = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const wc   = createWalletClient({ account: acct, chain: baseSepolia, transport: http(RPC_URL) });

const ABI = [
  { type:'function', name:'seedPool',  stateMutability:'nonpayable', inputs:[{name:'amount',type:'uint256'}], outputs:[] },
  { type:'function', name:'prizePool', stateMutability:'view',       inputs:[], outputs:[{name:'',type:'uint256'}] },
] as const;

async function main() {
  // Wait for any pending txs to clear
  const pending   = await pc.getTransactionCount({ address: acct.address, blockTag: 'pending' });
  const confirmed = await pc.getTransactionCount({ address: acct.address, blockTag: 'latest' });
  console.log(`nonce — pending: ${pending}, confirmed: ${confirmed}`);

  if (pending > confirmed) {
    console.log('pending txs detected, waiting 6s...');
    await new Promise(r => setTimeout(r, 6000));
  }

  console.log(`\ncalling seedPool(${formatUnits(AMOUNT, 18)} HIGHER)...`);
  const hash = await wc.writeContract({ address: CONTRACT, abi: ABI, functionName: 'seedPool', args: [AMOUNT] });
  process.stdout.write(`  tx ${hash.slice(0, 10)}… `);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  console.log(`confirmed in block ${receipt.blockNumber}`);

  const pool = await pc.readContract({ address: CONTRACT, abi: ABI, functionName: 'prizePool' });
  console.log(`prizePool: ${formatUnits(pool, 18)} HIGHER`);
  console.log('done.');
}

main().catch(err => {
  console.error('failed:', err.message);
  process.exit(1);
});
