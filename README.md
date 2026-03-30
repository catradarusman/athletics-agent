# Higher Athletics Commitment Agent

Farcaster bot for [/higher-athletics](https://warpcast.com/~/channel/higher-athletics). Users pledge $HIGHER tokens against fitness commitments. The agent validates proof-of-work casts with Claude, records them onchain, and settles commitments automatically.

**Flow:** user pledges → posts workout casts in /higher-athletics → agent validates each one with AI → after the commitment window closes, agent resolves onchain → pass: claim pledge back + bonus from the pool; fail: pledge forfeits to the pool.

---

## 1. Local setup

**Prerequisites:** Node 20+, PostgreSQL 14+

```bash
git clone <repo>
cd athletics-agent
npm install
```

Copy and fill in environment variables:

```bash
cp .env.example .env
```

See [Environment variables](#environment-variables) below for what each one does.

Apply the database schema:

```bash
psql $DATABASE_URL -f src/db/schema.sql
```

Start the dev server (TypeScript watch mode):

```bash
npm run dev
```

The server listens on `PORT` (default 3000) and exposes:

- `POST /webhook` — Neynar cast webhook
- `GET /health` — health check

---

## 2. Deploy

The project includes a `Dockerfile` and `railway.json` for one-click Railway deployment.

**Railway (recommended)**

1. Push the repo to GitHub.
2. Create a new Railway project → **Deploy from GitHub repo**.
3. Railway auto-detects the Dockerfile.
4. Add a **PostgreSQL** plugin from the Railway dashboard — it sets `DATABASE_URL` automatically.
5. Add all remaining environment variables under **Variables** (copy from `.env.example`).
6. Deploy. Railway will expose a public HTTPS URL — you'll need it for the Neynar webhook.

The `/health` endpoint is used as the Railway healthcheck.

---

## 3. Register the Neynar webhook

1. Go to [dev.neynar.com](https://dev.neynar.com) → your app → **Webhooks**.
2. Create a new webhook:
   - **URL:** `https://<your-railway-url>/webhook`
   - **Subscription type:** `cast.created`
   - **Channel filter:** `higher-athletics`
3. Copy the **Webhook Secret** into `WEBHOOK_SECRET` in your environment variables.
4. Copy the app's **API Key** into `NEYNAR_API_KEY`.

The bot only processes casts from the `/higher-athletics` channel. Casts in other channels are ignored at the handler level.

---

## 4. Deploy the smart contract

The contract is `HigherCommitmentPool.sol`. Constructor arguments:

| Argument | Description |
|---|---|
| `_higherToken` | $HIGHER ERC-20 address (`0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe` on mainnet) |
| `_feeRecipient` | Address that receives 10% protocol fees (set `FEE_RECIPIENT` in `.env`, or defaults to deployer) |
| `_agent` | Agent hot wallet address — set `AGENT_ADDRESS` or `AGENT_PRIVATE_KEY` in `.env` |

**Step 1 — compile the contracts:**

```bash
npm run hardhat compile
```

**Step 2 — deploy, grant `AGENT_ROLE`, and seed 100 000 $HIGHER in one shot:**

```bash
# Testnet
CHAIN_ID=84532 npm run deploy

# Mainnet
CHAIN_ID=8453 npm run deploy
```

The script will print the deployed `CONTRACT_ADDRESS`. Copy it into your `.env` (and Railway variables for the running agent).

The deployer wallet must hold at least 100 000 $HIGHER before running this. The script approves the contract and calls `seedPool` automatically.

**Verify on Basescan (optional but recommended):**

```bash
npm run hardhat -- verify --network base <CONTRACT_ADDRESS> \
  <HIGHER_TOKEN_ADDRESS> <FEE_RECIPIENT_ADDRESS> <AGENT_ADDRESS>
```

---

## 5. Seed the pool

To top up the pool after the initial deploy:

```bash
# Default: 100 000 $HIGHER
npm run seed-pool

# Custom amount
SEED_AMOUNT=50000 npm run seed-pool
```

The script handles the token approval step automatically. Requires `DEPLOYER_PRIVATE_KEY`, `CONTRACT_ADDRESS`, and `HIGHER_TOKEN_ADDRESS` in `.env`.

The pool balance is visible at any time via `@higherathletics pool` in the channel, or by calling `prizePool()` on the contract.

---

## 6. Rotate the agent wallet

To swap in a new agent hot wallet without redeploying:

```bash
# By address
NEW_AGENT_ADDRESS=0x… npm run update-agent

# By private key (address is derived)
NEW_AGENT_PRIVATE_KEY=0x… npm run update-agent

# Emergency: remove agent entirely (disables onchain writes until re-added)
REMOVE_AGENT=true npm run update-agent
```

After rotating: update `AGENT_PRIVATE_KEY` in your environment and restart the agent server. The new wallet needs ETH on Base for gas.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `NEYNAR_API_KEY` | yes | Neynar app API key |
| `BOT_SIGNER_UUID` | yes | Managed signer UUID for the bot account |
| `BOT_FID` | yes | Farcaster ID of the bot account |
| `WEBHOOK_SECRET` | yes | Neynar webhook secret for payload verification |
| `ANTHROPIC_API_KEY` | yes | Claude API key for proof validation |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `BASE_RPC_URL` | yes | Base mainnet RPC (use Alchemy or Infura in production) |
| `BASE_SEPOLIA_RPC_URL` | no | Base Sepolia RPC for testnet use |
| `AGENT_PRIVATE_KEY` | yes | Hot wallet private key — must hold `AGENT_ROLE` onchain |
| `CONTRACT_ADDRESS` | yes | Deployed `HigherCommitmentPool` address |
| `HIGHER_TOKEN_ADDRESS` | yes | $HIGHER ERC-20 address |
| `PORT` | no | HTTP port (default: 3000) |
| `NODE_ENV` | no | `production` disables dev tooling |
| `CHAIN_ID` | no | `84532` to use Base Sepolia; defaults to Base mainnet |
| `DEPLOYER_PRIVATE_KEY` | deploy only | Deployer wallet for deploy/seed/update-agent scripts |
| `FEE_RECIPIENT` | deploy only | Address for 10% protocol fees; defaults to deployer |
| `AGENT_ADDRESS` | deploy only | Agent wallet address for `deploy.ts`; derived from `AGENT_PRIVATE_KEY` if unset |
| `BASESCAN_API_KEY` | deploy only | For contract verification |

---

## Bot commands

In `/higher-athletics`, mention `@higherathletics`:

```
@higherathletics commit <template> <tier>
@higherathletics status
@higherathletics pool
```

**Templates:** `sprint` (7d/7 proofs) · `monthly-grind` (30d/12) · `builders-block` (14d/5) · `beast-mode` (30d/30)

**Tiers:** `starter` (1k) · `standard` (5k) · `serious` (10k) · `allin` (25k $HIGHER)

Any other cast in the channel (without a bot mention) is treated as a proof submission and validated automatically.
