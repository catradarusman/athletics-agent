# Higher Athletics Commitment Agent

Farcaster bot for [/higher-athletics](https://warpcast.com/~/channel/higher-athletics). Users pledge $HIGHER tokens against fitness commitments. The agent validates proof-of-work casts with Claude, records them onchain, and settles commitments automatically.

**Flow:**
1. User calls `@higherathletics commit [natural language goal]` → Claude parses the goal, bot records intent in DB as `created`, and replies with a snap link
2. User taps the snap link → reviews their parsed commitment → taps "lock pledge" → the **Farcaster Snap** opens a signing mini app that handles `approve($HIGHER)` + `createCommitment()` in two wallet prompts
3. User submits proof by mentioning `@higherathletics proof [evidence]` with text and/or an attached photo → agent validates with Claude (including vision analysis of images) and records proofs in DB + onchain
4. After the commitment window closes, the resolution cron settles the commitment onchain (hourly)
5. **Pass:** bot notifies with a snap link → user taps "claim reward" → signing mini app calls `claim()` → pledge − 10% fee + pool bonus lands in their wallet
6. **Fail:** pledge is forfeited to the prize pool; the bot notifies in the channel

The **Farcaster Snap** (`packages/snap/`) is a companion Hono app deployed to `https://higherathletics-snap.host.neynar.app`. It provides the in-feed UI for goal setup, progress tracking, and transaction signing. See [Snap deployment](#7-snap-deployment) for setup.

---

## Repository structure

```
athletics-agent/
  src/                    ← bot server (Express + Neynar webhooks)
    agent/                ← webhook handler, cron jobs, reply templates
    chain/                ← viem client, contract reads/writes, calldata encoders
    db/                   ← PostgreSQL queries (commitments, proofs, pool_events)
  contracts/              ← HigherCommitmentPool.sol (Hardhat project)
  scripts/                ← deploy, seed-pool, update-agent
  packages/
    snap/                 ← Farcaster Snap (Hono, deployed to host.neynar.app)
      src/
        index.ts          ← snap handler + landing/setup/review/status pages
        signing/pages.ts  ← HTML mini apps for approve+commit and claim txs
        chain.ts          ← direct RPC reads for the snap
        ai.ts             ← Claude Haiku goal parser
        api.ts            ← HTTP client to bot API
```

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
- `GET /api/commitment/:fid` — snap API: returns latest commitment state for a FID
- `POST /api/commitment/register` — snap API: creates `created` record after wallet connects; transitions to `paid` when the pledge tx confirms onchain
- `GET /api/pool` — snap API: returns active commitment count

To run the snap locally:

```bash
cd packages/snap
pnpm install
pnpm dev   # starts on port 3003 with JFS verification disabled
```

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

## 3. Register Neynar webhooks

Two webhooks are required. Both point to the same URL.

**Webhook 1 — channel casts** (proof submissions from non-mentions)

1. Go to [dev.neynar.com](https://dev.neynar.com) → your app → **Webhooks**.
2. Create a new webhook:
   - **URL:** `https://<your-railway-url>/webhook`
   - **Subscription type:** `cast.created`
   - **Channel filter:** `higher-athletics`
3. Copy the **Webhook Secret** into `WEBHOOK_SECRET` in your environment variables.

**Webhook 2 — bot mentions** (commands + conversational replies, including threads)

Neynar's channel filter misses threaded replies because they don't carry `channel.id`. A second webhook scoped to `mentioned_fid` catches all @mentions regardless of nesting.

Create it via the Neynar API (the portal doesn't expose `mentioned_fids` as a filter option):

```bash
curl -X POST https://api.neynar.com/v2/farcaster/webhook \
  -H "x-api-key: <NEYNAR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "higherathletics-mentions",
    "url": "https://<your-railway-url>/webhook",
    "subscription": {
      "cast.created": {
        "mentioned_fids": [<BOT_FID>]
      }
    }
  }'
```

The response includes a `secrets[0].value` — copy it into `WEBHOOK_SECRET_2` in your environment variables.

The server accepts requests signed by either secret, so both webhooks share the same endpoint. Duplicate deliveries of the same cast (triggered by both webhooks) are deduplicated in memory.

**Signature verification:** every `POST /webhook` is verified with HMAC-SHA512 over the raw request body (`x-neynar-signature` header) against `WEBHOOK_SECRET` and `WEBHOOK_SECRET_2`. Requests without a valid signature are rejected with HTTP 401. In production, the server refuses to start without `WEBHOOK_SECRET`. In development, a warning is logged but requests are accepted.

The bot ignores `@mentions` outside `/higher-athletics`. Channel scoping is enforced in code via `channel.id`, `root_parent_url`, and `parent_url` checks.

---

## 7. Snap deployment

The snap is a separate Hono app in `packages/snap/` deployed to [host.neynar.app](https://host.neynar.app).

**First deploy:**

```bash
# 1. Build the archive (exclude local dev server and node_modules)
cd packages/snap
tar czf /tmp/higher-athletics-snap.tar.gz \
  --exclude='./src/server.ts' \
  --exclude='./node_modules' \
  .

# 2. Deploy (saves apiKey in the response — store it for future redeploys)
curl -X POST https://api.host.neynar.app/v1/deploy \
  -F "files=@/tmp/higher-athletics-snap.tar.gz" \
  -F "projectName=higher-athletics-snap" \
  -F "framework=hono" \
  -F 'env={
    "SNAP_PUBLIC_BASE_URL":"https://higherathletics-snap.host.neynar.app",
    "BOT_API_URL":"<your-railway-url>",
    "SNAP_API_SECRET":"<shared-secret>",
    "CONTRACT_ADDRESS":"0x1f617029fa78e80dc5be42fdc563a8b39ace1afd",
    "HIGHER_TOKEN_ADDRESS":"0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe",
    "BASE_RPC_URL":"<your-rpc-url>",
    "ANTHROPIC_API_KEY":"<your-key>",
    "CHAIN_ID":"8453"
  }'
```

**Redeploy** (after receiving your `apiKey` from the first deploy):

```bash
curl -X POST https://api.host.neynar.app/v1/deploy \
  -H "Authorization: Bearer <apiKey>" \
  -F "files=@/tmp/higher-athletics-snap.tar.gz" \
  -F "projectName=higher-athletics-snap" \
  -F "framework=hono" \
  -F 'env={...}'
```

**Verify the snap is live:**

```bash
curl -s -H "Accept: application/vnd.farcaster.snap+json" \
  https://higherathletics-snap.host.neynar.app/
```

Should return `{"version":"2.0","theme":{"accent":"green"},...}`.

**Wire up the bot** — add these two variables to Railway after deploying the snap:

| Variable | Value |
|---|---|
| `SNAP_URL` | `https://higherathletics-snap.host.neynar.app` |
| `SNAP_API_SECRET` | same secret used in snap env above |

Once set, the bot's commit and claim replies will include the snap link.

---

## 4. Deploy the smart contract

**Mainnet deployment (2026-04-20):**

| | |
|---|---|
| Contract | [`0x1f617029fa78e80dc5be42fdc563a8b39ace1afd`](https://basescan.org/address/0x1f617029fa78e80dc5be42fdc563a8b39ace1afd#code) |
| Network | Base mainnet (chain ID 8453) |
| Prize pool | 100,000 $HIGHER (seeded at deploy) |
| Snap | [`higherathletics-snap.host.neynar.app`](https://higherathletics-snap.host.neynar.app) |

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
npx hardhat verify --network base <CONTRACT_ADDRESS> \
  <HIGHER_TOKEN_ADDRESS> <FEE_RECIPIENT_ADDRESS> <AGENT_ADDRESS>
```

> **Note:** `hardhat.config.js` uses a single `apiKey` string for `etherscan` (Etherscan V2 format). Per-network key maps are no longer accepted.

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
| `WEBHOOK_SECRET` | yes | Neynar webhook secret for the channel cast webhook |
| `WEBHOOK_SECRET_2` | yes | Neynar webhook secret for the `mentioned_fid` webhook |
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
| `MIN_NEYNAR_USER_SCORE` | no | Minimum Neynar user score to create commitments (default: 0.5). Sybil protection. |
| `SNAP_URL` | no | Snap URL appended to commit/claim replies. Set to `https://higherathletics-snap.host.neynar.app` |
| `SNAP_API_SECRET` | no | Shared secret for snap → bot API auth (`x-snap-secret` header). Required if snap is deployed. |
| `DEPLOYER_PRIVATE_KEY` | deploy only | Deployer wallet for deploy/seed/update-agent scripts |
| `FEE_RECIPIENT` | deploy only | Address for 10% protocol fees; defaults to deployer |
| `AGENT_ADDRESS` | deploy only | Agent wallet address for `deploy.ts`; derived from `AGENT_PRIVATE_KEY` if unset |
| `BASESCAN_API_KEY` | deploy only | For contract verification |

---

## Bot commands

The bot only responds to four explicit commands in `/higher-athletics`. All other mentions, general casts, and conversation are silently ignored.

```
@higherathletics commit [your goal]
@higherathletics proof [evidence]
@higherathletics status
@higherathletics cancel
```

**`commit` — create a commitment**

Describe your goal in plain language — Claude parses it into duration + proof frequency.

```
@higherathletics commit cycling every day for 15 days
@higherathletics commit run 5k three times a week for 30 days
@higherathletics commit walk 30 mins daily for 15 days
@higherathletics commit 3x/week gym for 30 days
@higherathletics commit run 10k total in 15 days
```

Any exercise counts: running, cycling, walking, swimming, gym, yoga, and more.

**Pledge tiers — two options, no other durations accepted:**

| Duration | Pledge | Tier |
|---|---|---|
| 15 days | 5,000 $HIGHER | Standard |
| 30 days | 10,000 $HIGHER | Serious |

If no duration is specified, the bot defaults to 30 days. Any other duration is rejected.

**Proof frequency:** at least 1 per week, at most 1 per day.

**Locking the pledge — via the snap (recommended):**

The bot reply includes a snap link. Tap it in Farcaster → the setup form opens with your goal **pre-filled** from the cast → verify or edit it → tap "next" → review your parsed commitment → tap "lock pledge". The snap opens a signing page that walks through `approve($HIGHER)` and `createCommitment()` with two wallet prompts. No manual calldata handling needed.

The pledge is only locked once both on-chain transactions confirm.

---

**`proof` — submit a proof of workout**

Mention the bot with `proof` followed by your evidence. Attach a photo or include specific details.

```
@higherathletics proof ran 5.2km in 31:45 this morning [attach Strava screenshot]
@higherathletics proof 45 min gym session, 3x10 squats at 80kg [attach photo]
@higherathletics proof morning ride 32km avg 28kph [attach Garmin screenshot]
```

The bot passes all attached images directly to Claude vision for analysis — it can read Strava stats, Garmin metrics, route maps, and workout photos. Accepted evidence: photos, tracking app screenshots (Strava, Garmin, Nike Run Club, Wahoo), or specific text descriptions with distance, time, reps, or duration. Generic statements without specifics or images are rejected.

The bot replies with the current proof count (`✓ 2/12. 18 days left`) or an invalid notice if the proof doesn't pass.

---

**`status` — check your progress**

```
@higherathletics status
```

Returns your current proof count, days remaining, pledge amount, and pace (on track or behind).

---

**`cancel` — cancel a pending commitment**

```
@higherathletics cancel
```

Cancels a commitment **only if the pledge has not yet been locked onchain** (status `created`). Once the `approve` + `createCommitment` transactions confirm (status `paid`), cancellation is not possible — no withdrawal function exists in the contract.

After a successful cancel the DB record is marked `cancelled` and you are free to start a new commitment immediately.

---

## Commitment status model

Each commitment moves through four statuses:

| Status | Meaning |
|--------|---------|
| `created` | User announced intent (`@higherathletics commit …`). DB record exists but pledge is not locked — no onchain tx yet. `start_time`/`end_time` are placeholders. **Cancellable via `@higherathletics cancel`.** |
| `paid` | User signed `approve` + `createCommitment` and both txs confirmed. `start_time` and `end_time` are updated from `block.timestamp` — the countdown starts here. Cannot be cancelled. |
| `end` | Commitment period has closed and was settled onchain by the resolution cron. The `outcome` column stores `'passed'` (proofs met) or `'failed'` (pledge forfeited to pool). |
| `claimed` | User called `claim()` onchain and received their payout. |
| `cancelled` | User cancelled before the pledge was locked. No onchain state was created; the FID is free to start a new commitment. |

The `outcome` column (`passed` / `failed` / `null`) is set when status transitions to `end`. It preserves the pass/fail distinction while keeping the status surface clean.

---

## Cron jobs

One job runs automatically once the server is started:

| Job | Schedule | Purpose |
|---|---|---|
| Resolution | Every hour | Settles expired commitments onchain; updates DB only after tx confirms |

> The reminder (6h) and weekly pool update (Monday 12:00 UTC) crons are disabled to reduce channel noise. They can be re-enabled in `src/agent/cron.ts` → `registerCronJobs()`.

The resolution cron also:
- **Reconciles unrecorded proofs** before settling — retries any proofs that were accepted in DB but failed to record onchain, preventing DB/chain divergence from causing wrongful failures.
- **Reads onchain status** after resolution to determine pass/fail for notifications (instead of relying on DB counts which may diverge).
- **Backfills** the onchain `commitment_id` for any commitment where the user delayed calling the contract, and cleans up orphaned DB records (intent announced but contract never called).
- **Tracks retries** per commitment (max 10) to avoid infinite loops on permanently failing transactions.

---

## Proof validation resilience

- **Claude API down:** proofs are saved with `ai_valid=null` (pending) and the user sees "proof received, validating." A future cron pass or retry can validate them.
- **Onchain recording failures:** each proof tracks `recorded_onchain` and `onchain_tx_hash` in the DB. The reconciliation cron retries unrecorded proofs before resolution.
- **Unconfirmed commitments:** if a user posts a proof before their `createCommitment()` tx confirms, the bot replies asking them to repost after confirmation (instead of silently ignoring).

---

## Security notes

- **Webhook signature:** every `POST /webhook` is verified with HMAC-SHA512 over the raw body against `WEBHOOK_SECRET` and `WEBHOOK_SECRET_2` (one per Neynar webhook). Either secret is accepted. Requests without a valid `x-neynar-signature` header are rejected with 401.
- **Reentrancy:** all state-changing contract functions use OpenZeppelin `ReentrancyGuard`. `claim()` and `resolveCommitment()` follow Checks-Effects-Interactions.
- **Access control:** `recordProof` and `resolveCommitment` require `AGENT_ROLE`; `seedPool`, `withdrawFees`, `pause`, and `updateAgent` require `DEFAULT_ADMIN_ROLE`.
- **Agent key:** use a dedicated hot wallet for `AGENT_PRIVATE_KEY` — never the deployer key. Rotate via `npm run update-agent` without redeploying the contract.
- **SQL injection:** all database queries use parameterised `$1/$2/…` placeholders; no string interpolation.
- **Sybil protection:** commitments require a minimum Neynar User Score (default 0.5). Users without a connected wallet are rejected.
- **Startup validation:** in production, the server refuses to start without `WEBHOOK_SECRET`.
