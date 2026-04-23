import { Hono } from "hono";
import { SPEC_VERSION, type SnapFunction, type SnapHandlerResult, type SnapElementInput } from "@farcaster/snap";
import { registerSnapHandler } from "@farcaster/snap-hono";
import {
  createTursoDataStore,
  createInMemoryDataStore,
} from "@farcaster/snap-turso";
import {
  fidHasActive,
  fidActiveId,
  getCommitment,
  getPoolBalance,
  encodeApproveData,
  encodeCreateCommitmentData,
  encodeClaimData,
  getContractAddress,
  getTokenAddress,
} from "./chain.js";
import { parseGoal, TIERS } from "./ai.js";
import { getCommitmentState } from "./api.js";
import { buildCommitHtml, buildClaimHtml } from "./signing/pages.js";
import type { ParsedCommitment } from "./ai.js";

// ─── Persistent store ─────────────────────────────────────────────────────────
// Stores parsed commitment params keyed by fid (1 hr TTL) so the review page
// doesn't need to re-parse the goal.

const data =
  process.env.VERCEL === "1"
    ? createTursoDataStore()
    : createInMemoryDataStore();

type StoredParsed = ParsedCommitment & { expiresAt: number };

async function storeParsed(fid: number, parsed: ParsedCommitment) {
  await data.set(`pending:${fid}`, {
    ...parsed,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
}

async function loadParsed(fid: number): Promise<ParsedCommitment | null> {
  const raw = (await data.get(`pending:${fid}`)) as StoredParsed | null;
  if (!raw || raw.expiresAt < Date.now()) return null;
  return raw;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString();
}

function daysLeft(endTime: string | Date): number {
  const end = typeof endTime === "string" ? new Date(endTime) : endTime;
  return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
}

function snapBase(req: Request): string {
  const fromEnv = process.env.SNAP_PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const fwdHost = req.headers.get("x-forwarded-host");
  const host = (fwdHost ?? req.headers.get("host"))?.split(",")[0].trim();
  const isLoopback =
    host !== undefined &&
    /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host);
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase() ??
    (isLoopback ? "http" : "https");
  return host ? `${proto}://${host}`.replace(/\/$/, "") : "http://localhost:3003";
}

function target(b: string, page: string) {
  return `${b}/?page=${page}`;
}

// ─── Snap function ────────────────────────────────────────────────────────────

const snap: SnapFunction = async (ctx) => {
  const b = snapBase(ctx.request);
  const url = new URL(ctx.request.url);
  const page = url.searchParams.get("page");
  const isPost = ctx.action.type === "post";

  // Safely extract FID from authenticated POST context
  const fid: number =
    isPost && ctx.action.type === "post"
      ? (ctx.action as unknown as { user: { fid: number } }).user?.fid ?? 0
      : 0;

  // GET (no user context) → always show landing page
  if (!isPost) {
    return buildLandingPage(b);
  }

  // POST routing via ?page= query param
  switch (page) {
    case "auth":
      return handleAuth(fid, b);
    case "review":
      return handleReview(ctx, fid, b);
    case "status":
      return handleStatus(fid, b);
    case "edit":
      return buildSetupForm(b, await loadParsed(fid));
    default:
      // First POST with no page param → same as auth
      return handleAuth(fid, b);
  }
};

// ─── Landing page (GET, no auth) ──────────────────────────────────────────────

async function buildLandingPage(b: string) {
  let poolStr = "loading...";
  try {
    const raw = await getPoolBalance();
    poolStr = `pool: ${fmt(Number(raw / BigInt(10 ** 18)))} $HIGHER`;
  } catch {
    poolStr = "pool: —";
  }

  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: { gap: "md" },
          children: ["title", "tag", "pool", "sep", "cta"],
        },
        title: {
          type: "text",
          props: { content: "higher athletics", weight: "bold" },
        },
        tag: {
          type: "text",
          props: {
            content: "lock in. show the work. get paid.",
            size: "sm",
          },
        },
        pool: { type: "text", props: { content: poolStr, size: "sm" } },
        sep: {
          type: "separator",
          props: { orientation: "horizontal" },
        },
        cta: {
          type: "button",
          props: { label: "check in", variant: "primary" },
          on: {
            press: {
              action: "submit",
              params: { target: target(b, "auth") },
            },
          },
        },
      },
    },
  };
}

// ─── Auth route: check FID → route to setup or status ────────────────────────

async function handleAuth(fid: number, b: string) {
  if (!fid) return buildErrorPage(b, "sign in to farcaster first");

  // Parallel: chain read + bot DB lookup
  const [hasActive, state] = await Promise.all([
    fidHasActive(fid).catch(() => false),
    getCommitmentState(fid).catch(() => ({ status: "none" as const })),
  ]);

  if (hasActive) return handleStatus(fid, b);

  // pending_onchain = bot created a DB record; user hasn't signed yet
  // → show setup form pre-filled with their cast goal
  if (state.status === "pending_onchain") {
    const diffDays = Math.round(
      (new Date(state.end_time).getTime() - new Date(state.start_time).getTime())
      / 86_400_000
    );
    const durationDays: 15 | 30 = diffDays <= 20 ? 15 : 30;
    const tier = TIERS[durationDays];
    const defaults: ParsedCommitment = {
      description:    state.template,
      durationDays,
      requiredProofs: state.required_proofs,
      amount:         tier.amount,
      tierIndex:      tier.tierIndex,
      tierName:       tier.tierName,
    };
    await storeParsed(fid, defaults);
    return buildSetupForm(b, defaults);
  }

  // active/passed/failed/claimed: chain may be unreachable; show DB status
  const KNOWN_STATUSES = new Set(["active", "passed", "failed", "claimed"]);
  if (KNOWN_STATUSES.has(state.status)) {
    return buildStatusFromDb(state, fid, b);
  }

  return buildSetupForm(b, null);
}

// ─── Setup form ───────────────────────────────────────────────────────────────

function buildSetupForm(
  b: string,
  defaults: ParsedCommitment | null,
  error?: string
) {
  const elements: Record<string, SnapElementInput> = {
    page: {
      type: "stack",
      props: { gap: "md" },
      children: error
        ? ["heading", "errbadge", "goal", "dur", "next", "back"]
        : ["heading", "goal", "dur", "next", "back"],
    },
    heading: {
      type: "text",
      props: { content: "what's the commitment?", weight: "bold" },
    },
    goal: {
      type: "input",
      props: {
        name: "goal",
        label: "goal",
        placeholder: 'e.g. "run 3x/week for 30 days"',
        maxLength: 200,
        defaultValue: defaults?.description ?? "",
      },
    },
    dur: {
      type: "toggle_group",
      props: {
        name: "duration",
        label: "duration",
        options: ["15 days — 5k $HIGHER", "30 days — 10k $HIGHER"],
        defaultValue:
          defaults?.durationDays === 15
            ? "15 days — 5k $HIGHER"
            : "30 days — 10k $HIGHER",
      },
    },
    next: {
      type: "button",
      props: { label: "next", variant: "primary" },
      on: {
        press: {
          action: "submit",
          params: { target: target(b, "review") },
        },
      },
    },
    back: {
      type: "button",
      props: { label: "back", variant: "secondary" },
      on: {
        press: {
          action: "submit",
          params: { target: target(b, "auth") },
        },
      },
    },
  };

  if (error) {
    elements.errbadge = {
      type: "badge",
      props: {
        label: error.slice(0, 30),
        color: "red",
        variant: "default",
      },
    };
  }

  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: { root: "page", elements },
  };
}

// ─── Review page handler (POST /?page=review) ─────────────────────────────────

async function handleReview(
  ctx: Parameters<SnapFunction>[0],
  fid: number,
  b: string
) {
  if (!fid) return buildErrorPage(b, "sign in to farcaster first");
  if (ctx.action.type !== "post") return buildSetupForm(b, null);

  const inputs = (
    ctx.action as unknown as { inputs: Record<string, string> }
  ).inputs;
  // Load stored commitment once — used as fallback for both goal and duration
  // when the snap SDK omits unchanged defaultValues from inputs.
  const stored = await loadParsed(fid);

  let goalText = (inputs.goal ?? "").trim();
  if (!goalText && stored) goalText = stored.description;

  const durChoice = inputs.duration ?? "";
  const durationDays: 15 | 30 = durChoice.startsWith("15") ? 15
    : durChoice.startsWith("30") ? 30
    : (stored?.durationDays === 15 ? 15 : 30);

  if (!goalText) {
    return buildSetupForm(b, null, "goal is required");
  }

  // Parse the goal text (may take up to ~2s; snap has 5s limit)
  const goalWithDuration = `${goalText} for ${durationDays} days`;
  const result = await parseGoal(goalWithDuration);

  if (!result.ok) {
    const fallback: ParsedCommitment = {
      description:    goalText,
      durationDays,
      requiredProofs: 3, // sensible fallback; user will re-submit
      amount:         TIERS[durationDays].amount,
      tierIndex:      TIERS[durationDays].tierIndex,
      tierName:       TIERS[durationDays].tierName,
    };
    return buildSetupForm(b, fallback, result.error.slice(0, 30));
  }

  const tier = TIERS[durationDays];
  const parsed: ParsedCommitment = {
    ...result.data,
    durationDays,
    tierIndex: tier.tierIndex,
    amount:    tier.amount,
    tierName:  tier.tierName,
  };

  // Store for edit flow
  await storeParsed(fid, parsed);

  // Pre-encode calldata server-side
  let approveCalldata = "";
  let commitCalldata = "";
  try {
    approveCalldata = encodeApproveData(parsed.amount);
    commitCalldata = encodeCreateCommitmentData(
      fid,
      parsed.tierIndex,
      parsed.durationDays,
      parsed.requiredProofs
    );
  } catch (err) {
    console.error("[snap] calldata encoding error:", err);
    return buildErrorPage(b, "contract not configured");
  }

  const signUrl =
    `${b}/sign/commit` +
    `?fid=${fid}` +
    `&approveData=${encodeURIComponent(approveCalldata)}` +
    `&commitData=${encodeURIComponent(commitCalldata)}` +
    `&tokenAddr=${encodeURIComponent(getTokenAddress())}` +
    `&contractAddr=${encodeURIComponent(getContractAddress())}` +
    `&description=${encodeURIComponent(parsed.description.slice(0, 120))}` +
    `&durationDays=${parsed.durationDays}` +
    `&proofs=${parsed.requiredProofs}` +
    `&tierIndex=${parsed.tierIndex}` +
    `&tierName=${encodeURIComponent(parsed.tierName)}` +
    `&amount=${parsed.amount}`;

  const desc = parsed.description.slice(0, 100);
  const proofWord = parsed.requiredProofs === 1 ? "proof" : "proofs";

  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: { gap: "md" },
          children: ["heading", "details", "note", "lock", "edit"],
        },
        heading: {
          type: "text",
          props: { content: "review", weight: "bold" },
        },
        details: {
          type: "item_group",
          props: { border: true },
          children: ["act", "dur", "proofs", "pledge"],
        },
        act: {
          type: "item",
          props: {
            title: "commitment",
            description: desc,
          },
        },
        dur: {
          type: "item",
          props: {
            title: "duration",
            description: `${parsed.durationDays} days`,
          },
        },
        proofs: {
          type: "item",
          props: {
            title: "proofs required",
            description: `${parsed.requiredProofs} ${proofWord}`,
          },
        },
        pledge: {
          type: "item",
          props: {
            title: "pledge",
            description: `${fmt(parsed.amount)} $HIGHER`,
          },
        },
        note: {
          type: "text",
          props: {
            content: "two wallet signatures: approve + lock",
            size: "sm",
          },
        },
        lock: {
          type: "button",
          props: { label: "lock pledge", variant: "primary" },
          on: {
            press: {
              action: "open_mini_app",
              params: { target: signUrl },
            },
          },
        },
        edit: {
          type: "button",
          props: { label: "edit", variant: "secondary" },
          on: {
            press: {
              action: "submit",
              params: { target: target(b, "edit") },
            },
          },
        },
      },
    },
  };
}

// ─── Status page ──────────────────────────────────────────────────────────────

async function handleStatus(fid: number, b: string) {
  if (!fid) return buildErrorPage(b, "sign in to farcaster first");

  // Try chain first for live data
  try {
    const hasActive = await fidHasActive(fid);
    if (hasActive) {
      const onchainId = await fidActiveId(fid);
      const c = await getCommitment(onchainId);
      const dl = daysLeft(c.endTime);
      const elapsed =
        (Date.now() - c.startTime.getTime()) /
        (c.endTime.getTime() - c.startTime.getTime());
      const onTrack =
        c.requiredProofs > 0
          ? c.verifiedProofs / c.requiredProofs >= elapsed * 0.8
          : true;
      const pace = onTrack ? "on pace" : "behind. pick it up";
      const amount = Number(c.pledgeAmount / BigInt(10 ** 18));

      return buildActiveStatus({
        b,
        verified: c.verifiedProofs,
        required: c.requiredProofs,
        daysLeft: dl,
        amount,
        pace,
        status: "active",
        commitmentId: Number(onchainId),
      });
    }
  } catch (err) {
    console.error("[snap] status chain read error:", err);
  }

  // Fallback to bot DB
  const state = await getCommitmentState(fid);
  return buildStatusFromDb(state, fid, b);
}

type ActiveStatusParams = {
  b: string;
  verified: number;
  required: number;
  daysLeft: number;
  amount: number;
  pace: string;
  status: "active" | "pending_onchain" | "passed" | "failed" | "claimed" | "none";
  commitmentId?: number;
};

function buildActiveStatus(p: ActiveStatusParams) {
  const { b, verified, required, daysLeft: dl, amount, pace, status, commitmentId } = p;

  if (status === "passed" && commitmentId !== undefined) {
    const payout = Math.round(amount * 0.9);
    let claimCalldata = "";
    let contractAddr = "";
    try {
      claimCalldata = encodeClaimData(commitmentId);
      contractAddr = getContractAddress();
    } catch {
      // contract not configured
    }
    const claimUrl =
      claimCalldata && contractAddr
        ? `${b}/sign/claim?commitmentId=${commitmentId}&amount=${amount}&contractAddr=${encodeURIComponent(contractAddr)}&claimData=${encodeURIComponent(claimCalldata)}`
        : "";

    const passedElements: Record<string, SnapElementInput> = {
      page: {
        type: "stack",
        props: { gap: "md" },
        children: ["done", "payout", "sep", ...(claimUrl ? ["claimbtn"] : []), "refresh"],
      },
      done: {
        type: "text",
        props: { content: `✓ ${verified}/${required}. done.`, weight: "bold" },
      },
      payout: {
        type: "text",
        props: { content: `${fmt(payout)} $HIGHER ready to claim`, size: "sm" },
      },
      sep: { type: "separator", props: { orientation: "horizontal" } },
      refresh: {
        type: "button",
        props: { label: "refresh", variant: "secondary" },
        on: { press: { action: "submit", params: { target: target(b, "status") } } },
      },
    };
    if (claimUrl) {
      passedElements.claimbtn = {
        type: "button",
        props: { label: "claim reward", variant: "primary" },
        on: { press: { action: "open_mini_app", params: { target: claimUrl } } },
      };
    }

    return { version: SPEC_VERSION, theme: { accent: "green" as const }, ui: { root: "page", elements: passedElements } };
  }

  if (status === "failed") {
    return {
      version: SPEC_VERSION,
      theme: { accent: "green" as const },
      ui: {
        root: "page",
        elements: {
          page: {
            type: "stack",
            props: { gap: "md" },
            children: ["result", "sub", "newbtn"],
          },
          result: {
            type: "text",
            props: {
              content: `${verified}/${required}. fell short.`,
              weight: "bold",
            },
          },
          sub: {
            type: "text",
            props: {
              content: `${fmt(amount)} $HIGHER to the pool`,
              size: "sm",
            },
          },
          newbtn: {
            type: "button",
            props: { label: "start again", variant: "primary" },
            on: {
              press: {
                action: "submit",
                params: { target: target(b, "auth") },
              },
            },
          },
        },
      },
    };
  }

  if (status === "pending_onchain") {
    return {
      version: SPEC_VERSION,
      theme: { accent: "green" as const },
      ui: {
        root: "page",
        elements: {
          page: {
            type: "stack",
            props: { gap: "md" },
            children: ["head", "sub", "refresh"],
          },
          head: {
            type: "text",
            props: { content: "waiting for tx to confirm", weight: "bold" },
          },
          sub: {
            type: "text",
            props: {
              content: "your pledge tx is pending. refresh in ~30s.",
              size: "sm",
            },
          },
          refresh: {
            type: "button",
            props: { label: "refresh", variant: "primary" },
            on: {
              press: {
                action: "submit",
                params: { target: target(b, "status") },
              },
            },
          },
        },
      },
    };
  }

  // Active commitment — show progress
  const progressLabel = `${verified} / ${required} proofs`;
  const daysStr = `${dl} day${dl === 1 ? "" : "s"} left`;

  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: { gap: "md" },
          children: ["proofcount", "bar", "meta", "sep", "proof", "channel", "refresh"],
        },
        proofcount: {
          type: "text",
          props: { content: progressLabel, weight: "bold" },
        },
        bar: {
          type: "progress",
          props: {
            value: verified,
            max: required,
            label: `${daysStr} · ${pace}`,
          },
        },
        meta: {
          type: "text",
          props: {
            content: `${fmt(amount)} $HIGHER pledged`,
            size: "sm",
          },
        },
        sep: { type: "separator", props: { orientation: "horizontal" } },
        proof: {
          type: "button",
          props: { label: "post a proof", variant: "primary" },
          on: {
            press: {
              action: "compose_cast",
              params: {
                text: "@higherathletics proof ",
                channelKey: "higher-athletics",
              },
            },
          },
        },
        channel: {
          type: "button",
          props: { label: "view channel", variant: "secondary" },
          on: {
            press: {
              action: "open_url",
              params: {
                target: "https://warpcast.com/~/channel/higher-athletics",
              },
            },
          },
        },
        refresh: {
          type: "button",
          props: { label: "refresh", variant: "secondary" },
          on: {
            press: {
              action: "submit",
              params: { target: target(b, "status") },
            },
          },
        },
      },
    },
  };
}

function buildStatusFromDb(
  state: Awaited<ReturnType<typeof getCommitmentState>>,
  fid: number,
  b: string
) {
  if (state.status === "none") {
    return buildSetupForm(b, null);
  }

  const { status, verified_proofs, required_proofs, pledge_amount, end_time, commitment_id } = state;
  const dl = daysLeft(end_time);

  // Estimate pace for active
  let pace = "on pace";
  if (status === "active") {
    const endTs = new Date(end_time).getTime();
    const startTs = 'start_time' in state
      ? new Date(state.start_time).getTime()
      : endTs - (30 * 86_400_000);
    const elapsed = (Date.now() - startTs) / (endTs - startTs);
    const onTrack =
      required_proofs > 0
        ? verified_proofs / required_proofs >= elapsed * 0.8
        : true;
    pace = onTrack ? "on pace" : "behind. pick it up";
  }

  return buildActiveStatus({
    b,
    verified: verified_proofs,
    required: required_proofs,
    daysLeft: dl,
    amount: pledge_amount,
    pace,
    status,
    commitmentId: commitment_id ?? undefined,
  });
}

// ─── Error page ───────────────────────────────────────────────────────────────

function buildErrorPage(b: string, message: string) {
  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: { gap: "md" },
          children: ["msg", "back"],
        },
        msg: {
          type: "text",
          props: { content: message.slice(0, 160) },
        },
        back: {
          type: "button",
          props: { label: "back", variant: "secondary" },
          on: {
            press: {
              action: "submit",
              params: { target: target(b, "auth") },
            },
          },
        },
      },
    },
  };
}

// ─── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono();

// Signing mini app pages — must be registered BEFORE registerSnapHandler
app.get("/sign/commit", (c) => {
  const q = c.req.query();
  const html = buildCommitHtml({
    fid: Number(q.fid ?? 0),
    description: decodeURIComponent(q.description ?? ""),
    durationDays: Number(q.durationDays ?? 30),
    requiredProofs: Number(q.proofs ?? 0),
    tierName: decodeURIComponent(q.tierName ?? "Standard"),
    amount: Number(q.amount ?? 5000),
    approveCalldata: decodeURIComponent(q.approveData ?? ""),
    commitCalldata: decodeURIComponent(q.commitData ?? ""),
    tokenAddr: decodeURIComponent(q.tokenAddr ?? ""),
    contractAddr: decodeURIComponent(q.contractAddr ?? ""),
    botApiUrl: process.env.BOT_API_URL ?? "",
    snapApiSecret: process.env.SNAP_API_SECRET ?? "",
    tierIndex: Number(q.tierIndex ?? 1),
    pledgeAmount: Number(q.amount ?? 5000),
  });
  return c.html(html);
});

app.get("/sign/claim", (c) => {
  const q = c.req.query();
  const commitmentId = Number(q.commitmentId ?? 0);
  const amount = Number(q.amount ?? 0);
  const contractAddr = decodeURIComponent(q.contractAddr ?? "");
  let claimCalldata = decodeURIComponent(q.claimData ?? "");

  // Re-encode if not provided in URL (fallback)
  if (!claimCalldata && commitmentId && contractAddr) {
    try {
      claimCalldata = encodeClaimData(commitmentId);
    } catch {
      claimCalldata = "";
    }
  }

  const html = buildClaimHtml({
    commitmentId,
    pledgeAmount: amount,
    contractAddr,
    claimCalldata,
  });
  return c.html(html);
});

const SNAP_BASE = (process.env.SNAP_PUBLIC_BASE_URL ?? "https://higherathletics-snap.host.neynar.app").replace(/\/$/, "");
const OG_IMAGE  = `${SNAP_BASE}/~/og-image`;
// Plain OG fallback — no fc:frame tag. fc:frame causes Neynar's embed crawler
// (which fetches without the snap Accept header) to cache this URL as a Mini App,
// which then goes through the domain-verification path instead of the snap protocol.
// Warpcast fetches embed URLs directly with Accept: application/vnd.farcaster.snap+json
// and uses that response for snap rendering.
const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>higher athletics</title>
<meta name="description" content="lock in. show the work. get paid.">
<meta property="og:title" content="higher athletics">
<meta property="og:description" content="lock in. show the work. get paid.">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:alt" content="higher athletics">
<meta property="og:url" content="${SNAP_BASE}/">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="higher athletics">
<meta name="twitter:description" content="lock in. show the work. get paid.">
<meta name="twitter:image" content="${OG_IMAGE}">
</head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#000;color:#fff;margin:0">
<div style="text-align:center;padding:24px">
<p style="font-size:18px;font-weight:bold;margin-bottom:8px">higher athletics</p>
<p style="font-size:14px;color:#aaa;margin-bottom:24px">lock in. show the work. get paid.</p>
<a href="https://farcaster.xyz" style="color:#22c55e;text-decoration:none">open in farcaster →</a>
</div>
</body>
</html>`;

// ─── Farcaster domain manifest ────────────────────────────────────────────────
// Required by Warpcast to render this Mini App as an embed in casts.
// Set FC_MANIFEST_HEADER / FC_MANIFEST_PAYLOAD / FC_MANIFEST_SIGNATURE env vars
// with the JFS values generated from the Warpcast developer tools:
//   warpcast.com/~/developers → "Domain Manifest" → domain: higherathletics-snap.host.neynar.app
app.get('/.well-known/farcaster.json', (c) => {
  const header    = process.env.FC_MANIFEST_HEADER;
  const payload   = process.env.FC_MANIFEST_PAYLOAD;
  const signature = process.env.FC_MANIFEST_SIGNATURE;
  const manifest: Record<string, unknown> = {
    miniapp: {
      version: '1',
      name: 'higher athletics',
      iconUrl: `${SNAP_BASE}/~/og-image`,
      homeUrl: `${SNAP_BASE}/`,
      imageUrl: `${SNAP_BASE}/~/og-image`,
      buttonTitle: 'check in',
      splashImageUrl: `${SNAP_BASE}/~/og-image`,
      splashBackgroundColor: '#000000',
    },
  };
  if (header && payload && signature) {
    manifest.accountAssociation = { header, payload, signature };
  }
  return c.json(manifest);
});

// Snap handler for all other routes
registerSnapHandler(app, snap, {
  openGraph: {
    title: "higher athletics",
    description: "lock in. show the work. get paid.",
  },
  fallbackHtml: FALLBACK_HTML,
});

export default app;
