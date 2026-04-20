# Roadmap

Development tracker for Higher Athletics. Items are ordered by priority within each section.

---

## In progress / next up

- [ ] **Live E2E test** — cast a real `commit` in `/higher-athletics`, complete the snap flow, submit a proof, verify resolution cron settles onchain
- [ ] **Re-enable reminder cron** — 6-hour reminder to users who haven't submitted a proof this period (disabled in `src/agent/cron.ts`)
- [ ] **Re-enable weekly pool update** — Monday 12:00 UTC cast announcing current pool balance and active commitment count

---

## Bot

- [ ] **`pool` command** — `@higherathletics pool` returns current prize pool + active commitments (hook into `GET /api/pool`)
- [ ] **Proof pending retry cron** — validate proofs saved with `ai_valid=null` (Claude API was down at submission time)
- [ ] **Duplicate proof guard** — reject proof casts submitted within the same calendar day for a once-per-day commitment
- [ ] **Multi-wallet support** — allow a FID to use a different wallet for a new commitment after a prior one ended
- [ ] **Graceful proof-before-commit** — friendlier reply when a user submits proof before their `createCommitment()` tx confirms

---

## Smart contract

- [ ] **Tier expansion** — add 7-day duration to the allowed set (contract currently enforces 7–60 days; README and bot restrict to 15/30)
- [ ] **Emergency withdrawal** — admin function to drain the contract to a safe address in case of critical bug
- [ ] **Upgradability review** — evaluate whether a proxy pattern is needed given the bot's central role

---

## Snap

- [ ] **Progress bar on status page** — visual proof progress (e.g. `████░░░░ 4/8`) already in UI but worth verifying accuracy
- [ ] **Claim flow confirmation** — show payout breakdown (pledge − fee + bonus) before opening the signing mini app
- [ ] **Error state pages** — handle snap API timeouts and contract read failures with a user-facing message instead of blank/broken UI
- [ ] **Snap API key rotation doc** — document the re-deploy process (current key: project `higherathletics-snap`, save the `57a6bbac` API key)

---

## Infrastructure

- [ ] **Private RPC** — replace `https://mainnet.base.org` with Alchemy or Coinbase Cloud to avoid rate limits (hit during deploy)
- [ ] **Railway health alerting** — add uptime monitor (Better Uptime / Grafana Cloud free tier) on `/health`
- [ ] **DB backups** — enable Railway PostgreSQL daily snapshots
- [ ] **Secrets audit** — rotate `ANTHROPIC_API_KEY`, `NEYNAR_API_KEY`, and `AGENT_PRIVATE_KEY` to dedicated project-scoped credentials

---

## Done

- [x] `HigherCommitmentPool.sol` — ERC-20 pledge locking, AGENT_ROLE, claim, resolve, prize pool (2026-03-10)
- [x] Farcaster bot — commit / proof / status commands, Claude proof validation, resolution cron (2026-03-10)
- [x] Webhook signature dual-secret — catches threaded replies via `mentioned_fid` webhook (2026-03-25)
- [x] Proof image vision — photo URLs passed to Claude vision for Strava/Garmin/photo validation (2026-04-07)
- [x] Farcaster Snap — in-feed UX for approve+commit and claim transactions (2026-04-16)
- [x] Mainnet deployment — contract deployed, pool seeded 100k $HIGHER, Basescan verified (2026-04-20)
- [x] Snap redeployed — updated contract address and new SNAP_API_SECRET wired to Railway (2026-04-20)
- [x] Cancel command — `@higherathletics cancel` cancels a `created` commitment before the pledge locks onchain (2026-04-20)
