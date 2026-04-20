# Changelog

All notable changes to the Higher Athletics bot are documented here.

---

## [2026-04-20] — Status model overhaul + end_time fix

### Fixed
- **`end_time` now calculated from pledge settlement, not intent date.** Previously `start_time`/`end_time` were set when the user posted `@higherathletics commit`, causing the countdown and resolution cron to run against the wrong window. Both are now updated from `block.timestamp` when the `createCommitment` tx confirms (backfill via `getCommitmentOnchain()`).
- **Expired commitments no longer block new ones** even if the resolution cron hasn't run yet. `getActiveCommitmentByFid()` now excludes rows where `end_time` has passed.
- **Direct replies to bot casts** (without `@higherathletics` in the text) are now processed. The previously dead `isReplyToBot()` helper is wired into the main handler.
- **Snap link now embeds inline in Farcaster** instead of opening a new tab. The snap URL is passed in the Neynar `embeds` array rather than appended as plain text.

### Changed
- **Commitment statuses renamed** to a cleaner four-value model:
  - `pending_onchain` → `created`
  - `active` → `paid`
  - `passed` / `failed` → `end` (pass/fail distinction preserved in new `outcome` column)
  - `claimed` unchanged
- **`outcome TEXT` column added** to `commitments` table (`passed` / `failed` / `null`). Set when status transitions to `end`.
- **`backfillCommitmentId()`** now accepts `startTime`/`endTime` and updates both columns alongside `commitment_id` and status.
- **`updateCommitmentStatus()`** signature changed: now takes `outcome: CommitmentOutcome` instead of `status`; always sets `status = 'end'`.
- All queries updated to reference new status/outcome values.

### Migration
Run the following on the Railway Postgres instance before deploying:
```sql
UPDATE commitments SET status = 'created' WHERE status = 'pending_onchain';
UPDATE commitments SET status = 'paid'    WHERE status = 'active';
UPDATE commitments SET status = 'end'     WHERE status IN ('passed', 'failed');
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS outcome TEXT;
UPDATE commitments SET outcome = 'passed' WHERE status = 'end' AND verified_proofs >= required_proofs;
UPDATE commitments SET outcome = 'failed' WHERE status = 'end' AND verified_proofs < required_proofs;
```

---

## [2026-04-20] — Mainnet deployment

### Deployed
- **`HigherCommitmentPool`** deployed to Base mainnet at `0x1f617029fa78e80dc5be42fdc563a8b39ace1afd`
  - Prize pool seeded with 100,000 $HIGHER
  - `AGENT_ROLE` granted to `0x0Cb57e00757A09d4C4289A4b2E4A70C7Ce56903A`
  - Contract verified on [Basescan](https://basescan.org/address/0x1f617029fa78e80dc5be42fdc563a8b39ace1afd#code)
- **Snap redeployed** to `https://higherathletics-snap.host.neynar.app` (project `higherathletics-snap`) with updated `CONTRACT_ADDRESS` and new `SNAP_API_SECRET`

### Changed
- **`hardhat.config.js`** — migrated `etherscan.apiKey` from per-network map to single string (Etherscan V2 API requirement)
- **`.env`** — `CONTRACT_ADDRESS` updated to mainnet address; `SNAP_URL` and `SNAP_API_SECRET` added

---

## [2026-04-16] — Farcaster Snap integration

### Added
- **`packages/snap/`** — new Hono app deployed to `host.neynar.app` that replaces the raw calldata reply with a guided in-feed transaction UX
  - Landing page shows pool stats and a "check in" button
  - Setup form collects goal + duration via natural language; Claude Haiku parses it server-side
  - Review page shows parsed commitment summary and opens the signing mini app
  - Status page shows a live progress bar, days remaining, and proof/claim buttons
  - `/sign/commit` — thin HTML mini app (via `open_mini_app`) that handles `approve($HIGHER)` + `createCommitment()` using `@farcaster/frame-sdk`
  - `/sign/claim` — thin HTML mini app that handles `claim(commitmentId)` in one tap
  - All calldata is pre-encoded server-side (viem `encodeFunctionData`) and injected as JS constants into the mini app HTML — no client-side ABI encoding
  - Snap deployed at `https://higher-athletics-snap.host.neynar.app`
- **`GET /api/commitment/:fid`** — new bot API endpoint for snap to read commitment state
- **`POST /api/commitment/register`** — new bot API endpoint called by the signing mini app after wallet connects; creates `pending_onchain` DB record with wallet address before tx is signed
- **`GET /api/pool`** — new bot API endpoint returning active commitment count for snap landing page
- **`countActiveCommitments()`** — efficient `COUNT(*)` query (previously loaded full rows)
- **`getLatestCommitmentByFid()`** — returns most recent non-claimed commitment for snap status + claim flow
- **`SNAP_URL`** env var — when set on the bot, appended to commit/claim replies as a tap-through link
- **`SNAP_API_SECRET`** env var — shared secret between bot and snap for API auth (`x-snap-secret` header)

### Changed
- **`handleCommit()` in `webhook.ts`** — removed raw calldata hex block (contractAddress, approve calldata, createCommitment calldata). Reply now ends with the snap URL when `SNAP_URL` is configured
- **`commitmentCreated()` in `replies.ts`** — accepts optional `snapUrl` param; replaces "sign tx below" instructions with "lock pledge + track progress: {snapUrl}"
- **`commitmentPassed()` in `replies.ts`** — accepts optional `snapUrl` param; replaces "call claim() on the contract" with "claim via snap: {snapUrl}"
- **`cron.ts`** resolution job — passes `SNAP_URL` to `commitmentPassed()` notifications

### Architecture note
Farcaster Snaps cannot call arbitrary contract functions directly (only `send_token` and `swap_token` exist as snap actions). The `open_mini_app` action is the bridge: the snap opens a URL as an in-app Farcaster webview, which has full EIP-1193 wallet access via `@farcaster/frame-sdk`. This is how both the approve+commit and claim flows are handled without leaving the feed.

---

## [2026-04-07] — Proof image vision + command hardening

### Changed
- Proof validation now passes photo URLs directly to Claude vision — reads Strava stats, Garmin metrics, route maps, and workout photos
- Replaced soft keyword matching with strict `@higherathletics proof [...]` command requirement
- Disabled reminder and weekly pool update crons to reduce channel noise

---

## [2026-03-25] — Webhook signature dual-secret

### Added
- `WEBHOOK_SECRET_2` — second Neynar webhook secret for the `mentioned_fid` scoped webhook. Both secrets are accepted on `POST /webhook`. This catches threaded replies that the channel-filter webhook misses.

### Changed
- HMAC-SHA512 verification now tries both `WEBHOOK_SECRET` and `WEBHOOK_SECRET_2`

---

## [2026-03-10] — Initial release

### Added
- Farcaster bot (`@higherathletics`) listening on `/higher-athletics` channel
- `commit` command: Claude parses natural language goals into tier + duration + proof frequency
- `proof` command: Claude validates submitted evidence, records proof in DB + onchain
- `status` command: returns current proof count, days remaining, pace
- PostgreSQL schema: `commitments`, `proofs`, `pool_events` tables
- Hourly resolution cron: settles expired commitments onchain, backfills commitment IDs, reconciles unrecorded proofs
- `HigherCommitmentPool.sol`: ERC-20 pledge locking, `AGENT_ROLE` for bot, `claim()`, `resolveCommitment()`, `prizePool()`
- Hardhat deploy + seed-pool + update-agent scripts
- Railway deployment via Dockerfile + `railway.json`
- Neynar webhook signature verification (HMAC-SHA512)
- Sybil protection via Neynar User Score threshold
