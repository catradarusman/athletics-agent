# Higher Athletics — Upgrade PRD
**Version:** 1.0  
**Author:** catra.eth  
**Status:** Ready to build  
**Repo:** github.com/catradarusman/athletics-agent

---

## What this doc is

A prompt-ready PRD for upgrading Higher Athletics from a reactive pledge bot into a full agentic commitment network with social graph mechanics and Farcaster Snap surfaces.

Paste any section directly into Claude Code / Cursor as a build prompt. Each sprint is self-contained.

---

## Context

Higher Athletics is a Farcaster bot (`@higherathletics`) in `/higher-athletics`. Users pledge $HIGHER tokens against fitness commitments. The bot validates proof-of-work casts with Claude vision, records them onchain via `HigherCommitmentPool.sol` on Base, and settles commitments automatically.

**Stack:** Node.js + TypeScript, Express, PostgreSQL, Neynar SDK, Anthropic SDK, Viem, Hardhat, Railway (backend), Vercel (frontend), Base mainnet.

**Current flow:**
1. User types `@higherathletics commit sprint standard` in `/higher-athletics`
2. Bot creates DB record, returns contract call data
3. User calls `createCommitment()` onchain to lock pledge
4. User posts workout casts → bot validates with Claude → records proof onchain
5. After window closes, cron resolves commitment onchain
6. Pass: user calls `claim()` to get pledge back + pool bonus. Fail: pledge forfeited.

**What's missing:** the bot only reacts. nobody sees what's happening. social cost of quitting is zero.

---

## Sprint 1 — Agentic Behaviors (no new UI)

**Goal:** make the bot initiate, not just respond.  
**Estimated effort:** 3-4 days  
**Files touched:** `src/agent/bot.ts`, `src/cron/`, new files in `src/agent/`

---

### 1.1 Proactive Nudge Cron

**Prompt for Claude Code:**

```
In the Higher Athletics bot (athletics-agent repo), add a proactive nudge cron job.

Context:
- Stack: Node.js + TypeScript, node-cron, Express, PostgreSQL, Neynar SDK
- Existing cron file: src/cron/resolution.ts (reference this for pattern)
- Existing DB queries: src/db/queries.ts (use getActiveCommitments or equivalent)
- Bot cast function: castReply() in src/agent/bot.ts
- Existing reminder templates: reminderGentle() and reminderUrgent() in src/agent/replies.ts

Task:
Create src/cron/nudge.ts that runs every 6 hours.

Logic:
1. Query DB for all active commitments where:
   - status = 'active'
   - end_time is within 72 hours from now
   - verified_proofs < required_proofs
   - A nudge hasn't been sent in the last 12 hours (add nudge_sent_at column to commitments table)
2. For each: calculate proofs_remaining and hours_left
3. If hours_left < 24: use reminderUrgent({ needed: proofs_remaining, hours: hours_left })
4. If hours_left < 72: use reminderGentle({ current: verified_proofs, total: required_proofs, daysLeft: Math.ceil(hours_left/24) })
5. Cast the reminder as a reply to the user's most recent proof cast (get cast_hash from proofs table, last row for that commitment_id). If no proof exists yet, cast into /higher-athletics channel mentioning their FID.
6. Update nudge_sent_at timestamp

DB migration needed: ALTER TABLE commitments ADD COLUMN nudge_sent_at TIMESTAMP;

Register this cron in src/index.ts alongside the existing resolution cron.
```

---

### 1.2 Social Graph Accountability Pairs

**Prompt for Claude Code:**

```
In the Higher Athletics bot (athletics-agent repo), add social graph awareness to the commit flow.

Context:
- When a user commits, the handleCommit() function in src/agent/webhook.ts creates a DB record and replies with commitmentCreated()
- Neynar SDK is initialized in src/agent/bot.ts as `neynar`
- Neynar SDK method to fetch following: neynar.fetchUserFollowing({ fid: number, limit: number })
- DB query available: getActiveCommitmentByFid(fid) in src/db/queries.ts

Task:
After the commitmentCreated reply is sent in handleCommit(), add the following:

1. Call neynar.fetchUserFollowing({ fid: cast.author.fid, limit: 100 }) to get the user's following list
2. Extract FIDs from the response (response.users[].fid)
3. For each FID (in batches of 10 max to avoid DB hammering), call getActiveCommitmentByFid(fid)
4. Collect matches: FIDs that have an active commitment
5. If 1 match: cast a follow-up reply to the original commit cast:
   "@[username] is also on a [template] this week. you're not doing this alone"
   (fetch username via getUserByFid from bot.ts)
6. If 2+ matches: 
   "[count] people you follow are active right now. [username1], [username2]..."
   (cap display at 2 names + "and X others" if more)
7. If 0 matches: skip, no reply

Wrap the whole thing in try/catch — social graph lookup should never block the commit flow. Fire it async after the main reply.
```

---

### 1.3 Streak Broadcast to /higher

**Prompt for Claude Code:**

```
In the Higher Athletics bot (athletics-agent repo), add a streak broadcast when a commitment is completed.

Context:
- In src/agent/webhook.ts, inside handleProof(), when isComplete is true, the bot calls castReply() with commitmentPassed()
- castInChannel() exists in src/agent/bot.ts for posting to a channel without a parent
- The /higher channel ID is 'higher'

Task:
After the commitmentPassed() reply in handleProof(), when isComplete === true:

1. Fetch the user's display name via getUserByFid(fid) from bot.ts
2. Get their template name and pledge amount from the commitment object
3. Cast into the /higher channel (not /higher-athletics) with this format:

"@[username] just finished [template]. [verified_proofs] proofs. [pledge_amount] $HIGHER on the line the whole time.

/higher-athletics"

The last line "/higher-athletics" acts as a channel tag/link back.

4. Add a try/catch — broadcast should never block the proof validation flow.

Note: castInChannel signature is castInChannel(text: string, channelId: string). Use channelId = 'higher'.
```

---

### 1.4 Post-Failure Analysis

**Prompt for Claude Code:**

```
In the Higher Athletics bot (athletics-agent repo), add AI-powered post-failure analysis when a commitment fails.

Context:
- In src/cron/resolution.ts, when a commitment resolves as failed, the bot calls commitmentFailed() and casts a reply
- Anthropic SDK is initialized in the project (see src/ai/validator.ts for pattern)
- Proofs for a commitment are queryable via getProofsByCommitmentId(commitmentId) from src/db/queries.ts
- Each proof has: created_at, cast_text, ai_summary, ai_valid fields

Task:
After the failed resolution cast in the resolution cron, add:

1. Fetch all proofs for this commitment via getProofsByCommitmentId()
2. Build a simple proof timeline: array of { day: number, summary: ai_summary, valid: ai_valid }
   (day = Math.ceil((proof.created_at - commitment.start_time) / 86400000))
3. Call Claude API with this prompt:

System: "You are the Higher Athletics bot. You speak in lowercase. No punctuation at end of last line. Max 3 lines. Be specific about the pattern. Never motivate — only describe what the data shows."

User: "Commitment: [template], [required_proofs] proofs needed over [duration] days.
Proof history: [timeline as simple text list]
Total submitted: [verified_proofs]/[required_proofs]

In 2-3 lines, describe exactly where and when this person dropped off. Be specific. No advice."

4. Cast the Claude response as a follow-up reply (separate from the failure notification) to the user's last cast in the commitment thread.

Use model: claude-sonnet-4-5, max_tokens: 150.
Wrap in try/catch — analysis failure should never affect settlement flow.
```

---

## Sprint 2 — Farcaster Snaps

**Goal:** replace text commands with in-feed interactive UI.  
**Estimated effort:** 5-7 days  
**New repo or subdirectory:** `snaps/` inside athletics-agent, or separate repo `athletics-snaps`

**Important constraints (Farcaster Snap spec):**
- Version must be `"2.0"`
- UI uses `ui.root` + `ui.elements` flat map format
- Max 7 root children, max 64 elements total, max 4 nesting depth
- Button actions via `on.press` with `action` + `params`
- `submit` action = server round-trip (POST to your backend)
- `compose_cast` = pre-fills a Warpcast cast (no server call)
- `view_profile` = opens Farcaster profile
- No direct wallet transactions — surface contract data for user to execute
- Deploy to host.neynar.app

---

### 2.1 Status Snap

**What it does:** shows current commitment progress in-feed. Bot casts this when user requests status or on proactive nudge.

**Prompt for Claude Code:**

```
Build a Farcaster Snap called "athletics-status-snap" using the snap template at https://github.com/farcasterxyz/snap/tree/main/template.

Read the full snap docs at https://docs.farcaster.xyz/snap/llms.txt before writing any code.

This snap shows a user's current Higher Athletics commitment status.

Backend API endpoint to query (already exists):
GET https://[RAILWAY_URL]/api/snap/status?fid=[fid]

Response shape:
{
  found: boolean,
  username: string,
  template: string,
  verifiedProofs: number,
  requiredProofs: number,
  daysLeft: number,
  pledgeAmount: number,
  onTrack: boolean,
  lastProofAt: string | null
}

Snap behavior:

STATE 1 — No active commitment (found: false):
- text: "no active commitment" (bold, center)
- text: "pledge $HIGHER against a goal" (sm, center)  
- button: "start a commitment" → compose_cast pre-filled with "@higherathletics commit sprint standard"
- theme accent: green

STATE 2 — Active commitment (found: true):
- text: "@[username]" (sm, gray)
- text: "[verifiedProofs]/[requiredProofs] proofs" (bold, lg, center)
- text: "[template] · [daysLeft] days left" (sm)
- text: "[pledgeAmount] $HIGHER at stake" (sm)
- button (primary): "submit proof" → compose_cast pre-filled with a workout cast template:
  "day [verifiedProofs+1]: [leave blank for user to fill]\n\n/higher-athletics"
- button (secondary): "check pool" → submit → POST to /api/snap/pool
- progress visualization: use bar_chart with two bars: "done" (verifiedProofs) and "needed" (requiredProofs - verifiedProofs)
- theme accent: green if onTrack, amber if !onTrack

The snap reads ctx.user.fid to know who's tapping.

Deploy to host.neynar.app with projectName: "athletics-status-snap"
Set SNAP_PUBLIC_BASE_URL env var to the live URL.

The Railway backend needs a new route: GET /api/snap/status — add this to the athletics-agent Express app. It queries the commitments table for the FID and returns the shape above.
```

---

### 2.2 Commit Snap

**What it does:** replaces the text command flow with a visual template + tier selector. Bot casts this when someone mentions `@higherathletics` without a full command, or when proactively recruiting.

**Prompt for Claude Code:**

```
Build a Farcaster Snap called "athletics-commit-snap" using the snap template.

Read the full snap docs at https://docs.farcaster.xyz/snap/llms.txt first.

This snap is a multi-step commitment flow: template selection → tier selection → confirmation.

State is stored in Turso (use createTursoDataStore from @farcaster/snap-turso).
Key pattern: "session:[fid]" → { step: "template"|"tier"|"confirm", template?: string, tier?: string }

SCREEN 1 — Template selection (default / step = "template"):
- text: "choose your commitment" (bold)
- text: "higher athletics" (sm, gray)
- bar_chart showing templates with success rates (fetch from GET /api/snap/templates):
  Response: [{ name: string, label: string, duration: number, proofs: number, successRate: number }]
  Show as bar_chart items: label + successRate as value
- 4 buttons in a row (use container):
  "sprint" → submit → /snap/commit/select-template?t=sprint
  "monthly-grind" → submit → /snap/commit/select-template?t=monthly-grind  
  "builders-block" → submit → /snap/commit/select-template?t=builders-block
  "beast-mode" → submit → /snap/commit/select-template?t=beast-mode

SCREEN 2 — Tier selection (step = "tier"):
- text: "how much are you putting up?" (bold)
- text: "[template name] selected" (sm, gray)
- 4 items showing each tier:
  item label: "starter" subtitle: "1,000 $HIGHER · lowest risk"
  item label: "standard" subtitle: "5,000 $HIGHER"
  item label: "serious" subtitle: "10,000 $HIGHER"
  item label: "all-in" subtitle: "25,000 $HIGHER · highest reward"
  Each item has a button in actions slot: "pick" → submit → /snap/commit/select-tier?tier=[name]
- button (secondary): "back" → submit → /snap/commit/back

SCREEN 3 — Confirmation (step = "confirm"):
- text: "[template] · [tier amount] $HIGHER" (bold, center)
- text: "[duration] days · [proofs] proofs needed" (sm)
- text: "10% fee on completion · bonus from prize pool on pass" (sm, gray)
- Show social context if available (fetch from GET /api/snap/social?fid=[fid]):
  Response: { followingActive: number, names: string[] }
  If followingActive > 0: text "[N] people you follow are active" (sm, green)
- button (primary): "lock it in" → compose_cast pre-filled with:
  "@higherathletics commit [template] [tier]"
  (user sends the cast, which triggers the existing bot flow)
- button (secondary): "start over" → submit → /snap/commit/reset

Note: The confirmation screen uses compose_cast (not submit) so the actual commitment goes through the existing bot webhook. The snap handles selection UX only.

Backend routes to add to athletics-agent Express app:
- GET /api/snap/templates → return templates array with success rates from DB
- GET /api/snap/social?fid=[fid] → return following count active in commitments

Deploy to host.neynar.app with projectName: "athletics-commit-snap"
```

---

### 2.3 Leaderboard Snap

**What it does:** weekly digest cast into /higher-athletics as a snap. Bot casts this every Monday automatically.

**Prompt for Claude Code:**

```
Build a Farcaster Snap called "athletics-leaderboard-snap".

Read the full snap docs at https://docs.farcaster.xyz/snap/llms.txt first.

This snap shows the weekly Higher Athletics leaderboard.

Backend endpoint: GET /api/snap/leaderboard
Response:
{
  week: string,  // "May 5–11"
  topUsers: [{ fid: number, username: string, proofs: number, template: string }],  // top 5
  stats: { active: number, passed: number, failed: number, poolBalance: number }
}

Snap UI:
- text: "higher athletics" (bold)
- text: "[week]" (sm, gray)
- bar_chart: top 5 users by proofs completed
  items: username as label, proofs as value (max 6 items for bar_chart)
  Each bar is tappable: view_profile action with their FID
- divider
- 3 items in a row (use container with 3 cells or separate items):
  "[active] active" / "[passed] passed" / "[failed] failed"
- text: "pool: [poolBalance] $HIGHER" (sm, gray, center)
- button (primary): "join" → compose_cast pre-filled "@higherathletics commit sprint standard"
- theme accent: green

The snap is stateless — no Turso needed. Just fetches fresh data on every GET.

Backend route to add to athletics-agent:
GET /api/snap/leaderboard — queries commitments table for current week stats + top 5 by verified_proofs among passed+active commitments this week.

Also add a cron job in the athletics-agent that runs every Monday at 09:00 UTC:
- Fetches the leaderboard snap URL
- Casts it into /higher-athletics channel using castInChannel() with the snap URL embedded
  Format: "week [N] leaderboard\n\nhttps://athletics-leaderboard-snap.host.neynar.app"

Deploy to host.neynar.app with projectName: "athletics-leaderboard-snap"
```

---

## Sprint 3 — Social Mechanics

**Goal:** peer-to-peer challenge and group commitment.  
**Estimated effort:** 7-10 days  
**Files touched:** `src/agent/webhook.ts`, `contracts/HigherCommitmentPool.sol`, `src/db/schema.sql`, new snap

---

### 3.1 Challenge Snap (1v1)

**Prompt for Claude Code:**

```
Add a 1v1 challenge mechanic to Higher Athletics.

Part A — Bot command (athletics-agent webhook.ts):

Add a new command handler: handleChallenge()

Trigger: cast mentions @higherathletics and contains "challenge @[username]"

Parse: extract the mentioned username from cast.mentioned_profiles (the one that isn't the bot)

Flow:
1. Look up the challenged user's FID via neynar.searchUser() or from mentioned_profiles
2. Check if challenger has an active commitment — if yes, reply "finish your current commitment first"
3. Check if challenged user already has one — note it but don't block
4. Pick default template from cast text if specified (e.g. "challenge @friend sprint"), else default to "sprint"
5. Pick default tier if specified, else "standard"
6. Cast a Challenge Snap (see Part B) into /higher-athletics, replying to the original cast
7. Store challenge in new DB table: challenges({ id, challenger_fid, challenged_fid, template, tier, status: 'pending'|'accepted'|'declined', created_at, expires_at (24h) })

Add new DB table to schema.sql:
CREATE TABLE IF NOT EXISTS challenges (
  id SERIAL PRIMARY KEY,
  challenger_fid BIGINT NOT NULL,
  challenged_fid BIGINT NOT NULL,
  template TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

Add cron to expire pending challenges after 24h (simple UPDATE + cast notification).

Part B — Challenge Snap (new snap: athletics-challenge-snap):

Read the full snap docs at https://docs.farcaster.xyz/snap/llms.txt first.

The snap is cast with a challenge_id param: https://athletics-challenge-snap.host.neynar.app/?challenge=[id]

Backend endpoint: GET /api/snap/challenge?id=[id]
Response: { challengeId, challengerUsername, challengerFid, challengerStats: { completions: number, winRate: number }, template, tier, pledgeAmount, status }

Snap UI (status = 'pending', ctx.user.fid = challenged_fid):
- text: "@[challengerUsername] challenges you" (bold)
- text: "[template] · [pledgeAmount] $HIGHER" (sm)
- text: "[challengerStats.completions] completions · [challengerStats.winRate]% win rate" (sm, gray)
- text: "winner takes loser's pledge" (sm, amber)
- button (primary): "accept" → compose_cast pre-filled:
  "@higherathletics accept-challenge [challengeId]"
- button (secondary): "decline" → compose_cast pre-filled:
  "@higherathletics decline-challenge [challengeId]"

Also add handleAcceptChallenge() and handleDeclineChallenge() to webhook.ts.
Accept: create commitments for both users, cast confirmation.
Decline: update status, cast notification to challenger.

Deploy snap to host.neynar.app with projectName: "athletics-challenge-snap"
```

---

### 3.2 Squad Commitments

> **Pre-condition:** run 1 manual squad first (3 people, 7 days). Observe where coordination breaks down. Build after.

**Prompt for Claude Code (after manual test):**

```
Add squad commitment mechanic to Higher Athletics.

Command: @higherathletics squad @a @b @c sprint standard
(min 2 members, max 4, plus the squad creator = max 5 total)

Part A — DB schema additions:

CREATE TABLE IF NOT EXISTS squads (
  id SERIAL PRIMARY KEY,
  creator_fid BIGINT NOT NULL,
  template TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'forming', -- forming | active | passed | failed
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL  -- 24h to confirm, then squad dissolves
);

CREATE TABLE IF NOT EXISTS squad_members (
  id SERIAL PRIMARY KEY,
  squad_id INTEGER REFERENCES squads(id),
  fid BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | declined
  commitment_id INTEGER REFERENCES commitments(id)
);

Part B — Bot flow (webhook.ts):

1. handleSquad(): parse @mentions, create squad record + squad_member rows, cast Squad Snap to all tagged users
2. When all members confirm → create individual commitments for each, link via commitment_id, update squad status to 'active'
3. Squad passes if ALL members pass. Squad fails if ANY member fails before deadline.
4. On squad pass: each member gets standard bonus + 0.5x multiplier (requires contract change — see Part C)
5. On squad fail: all pledges forfeit as normal. Bot casts which member dropped off first.

Part C — Contract note:
The squad bonus multiplier requires a new resolveSquad() function on HigherCommitmentPool.sol.
This is a separate contract upgrade. Build and test on Base Sepolia first.
Use Hardhat for deployment. Follow existing deploy.ts pattern.

Part D — Squad Snap (athletics-squad-snap):

Read the full snap docs at https://docs.farcaster.xyz/snap/llms.txt first.

Simple confirmation snap:
- text: "@[creatorUsername] is starting a squad" (bold)
- text: "[template] · [pledgeAmount] $HIGHER each" (sm)
- Show member list as items: each pending member with status indicator
- text: "all members must pass or everyone loses bonus" (sm, amber)
- button (primary): "i'm in" → compose_cast "@higherathletics join-squad [squadId]"
- button (secondary): "pass" → compose_cast "@higherathletics leave-squad [squadId]"

Deploy to host.neynar.app with projectName: "athletics-squad-snap"
```

---

## API Routes Reference

All new routes to add to the Express app in `athletics-agent`:

| Method | Route | Used by |
|---|---|---|
| GET | `/api/snap/status?fid=` | Status snap |
| GET | `/api/snap/templates` | Commit snap |
| GET | `/api/snap/social?fid=` | Commit snap |
| GET | `/api/snap/leaderboard` | Leaderboard snap |
| GET | `/api/snap/challenge?id=` | Challenge snap |
| GET | `/api/snap/squad?id=` | Squad snap |

---

## Environment Variables to Add

```env
# Snap URLs (add after each snap deploy)
STATUS_SNAP_URL=https://athletics-status-snap.host.neynar.app
COMMIT_SNAP_URL=https://athletics-commit-snap.host.neynar.app
LEADERBOARD_SNAP_URL=https://athletics-leaderboard-snap.host.neynar.app
CHALLENGE_SNAP_URL=https://athletics-challenge-snap.host.neynar.app
SQUAD_SNAP_URL=https://athletics-squad-snap.host.neynar.app

# /higher channel ID for broadcasts
HIGHER_CHANNEL_ID=higher
```

---

## Build Order

```
week 1
  day 1-2: 1.1 proactive nudge cron
  day 3:   1.2 social graph pairs on commit
  day 4:   1.3 streak broadcast to /higher
  day 5:   1.4 post-failure analysis

week 2
  day 1-2: 2.1 status snap + /api/snap/status route
  day 3-4: 2.2 commit snap + /api/snap/templates + social route
  day 5:   2.3 leaderboard snap + Monday cron

week 3
  run 1 manual squad (observe, don't code yet)
  day 1-3: 3.1 challenge snap + bot commands
  day 4-5: 3.1 challenge bot commands (accept/decline flow)

week 4
  (after manual squad debrief)
  day 1-4: 3.2 squad DB + bot flow
  day 5:   3.2 squad snap
  post:    3.2 contract upgrade (separate sprint, Base Sepolia first)
```

---

## What NOT to build (yet)

- **Streak NFT** — needs miniapp or external site. out of scope until snap UX is stable.
- **Crowd backs** — new contract primitive. validate manually first.
- **More templates or tiers** — not a retention problem.
- **Miniapps** — Farcaster is sunsetting frames. snaps only.
