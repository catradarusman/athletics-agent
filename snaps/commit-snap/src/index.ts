import { SPEC_VERSION, type SnapFunction, type SnapElementInput } from "@farcaster/snap";
import { registerSnapHandler } from "@farcaster/snap-hono";
import {
  createInMemoryDataStore,
  createTursoDataStore,
} from "@farcaster/snap-turso";
import { Hono } from "hono";

// ── Persistent session store ──────────────────────────────────────────────────

const data =
  process.env.VERCEL === "1"
    ? createTursoDataStore()
    : createInMemoryDataStore();

// ── Static metadata ───────────────────────────────────────────────────────────

interface Session {
  step: "template" | "tier" | "confirm";
  template?: string;
  tier?: string;
}

interface TemplateInfo {
  name: string;
  label: string;
  duration: number;
  proofs: number;
  successRate: number;
}

const TEMPLATE_META: Record<string, { duration: number; proofs: number }> = {
  sprint:           { duration: 7,  proofs: 3  },
  "monthly-grind":  { duration: 30, proofs: 20 },
  "builders-block": { duration: 14, proofs: 10 },
  "beast-mode":     { duration: 30, proofs: 30 },
};

const TIER_META: Record<string, { amount: number; description: string }> = {
  starter:  { amount: 1_000,  description: "1,000 $HIGHER · lowest risk"     },
  standard: { amount: 5_000,  description: "5,000 $HIGHER"                   },
  serious:  { amount: 10_000, description: "10,000 $HIGHER"                  },
  "all-in": { amount: 25_000, description: "25,000 $HIGHER · highest reward" },
};

// ── Snap handler ──────────────────────────────────────────────────────────────

const snap: SnapFunction = async (ctx) => {
  const fid = ctx.action.user?.fid;
  const base = snapBaseUrlFromRequest(ctx.request);
  const url = new URL(ctx.request.url);
  const action = url.searchParams.get("action");
  const sessionKey = `session:${fid ?? "anon"}`;

  let session = ((await data.get(sessionKey)) as Session | null) ?? {
    step: "template",
  };

  // Mutate session based on action
  if (action === "select-template") {
    const t = url.searchParams.get("t");
    if (t && t in TEMPLATE_META) {
      session = { step: "tier", template: t };
      await data.set(sessionKey, session as unknown as import("@farcaster/snap-turso").DataStoreValue);
    }
  } else if (action === "select-tier") {
    const tier = url.searchParams.get("tier");
    if (tier && tier in TIER_META && session.template) {
      session = { step: "confirm", template: session.template, tier };
      await data.set(sessionKey, session as unknown as import("@farcaster/snap-turso").DataStoreValue);
    }
  } else if (action === "back" || action === "reset") {
    session = { step: "template" };
    await data.set(sessionKey, session as unknown as import("@farcaster/snap-turso").DataStoreValue);
  }

  // Render
  if (session.step === "tier" && session.template) {
    return renderTier(session.template, base);
  }
  if (session.step === "confirm" && session.template && session.tier) {
    return renderConfirm(session.template, session.tier, fid, base);
  }
  return renderTemplate(base);
};

// ── Screen renderers ──────────────────────────────────────────────────────────

async function renderTemplate(base: string) {
  let bars: { label: string; value: number }[] = [
    { label: "sprint",         value: 0 },
    { label: "monthly grind",  value: 0 },
    { label: "builders block", value: 0 },
    { label: "beast mode",     value: 0 },
  ];

  try {
    const res = await fetch(`${process.env.RAILWAY_URL}/api/snap/templates`);
    if (res.ok) {
      const templates = (await res.json()) as TemplateInfo[];
      bars = templates.map((t) => ({ label: t.label, value: t.successRate }));
    }
  } catch {
    // fall through to defaults
  }

  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: {},
          children: ["title", "subtitle", "chart", "buttons"],
        },
        title: {
          type: "text",
          props: { content: "choose your commitment", weight: "bold" },
        },
        subtitle: {
          type: "text",
          props: { content: "higher athletics", size: "sm" },
        },
        chart: {
          type: "bar_chart",
          props: { bars, max: 100 },
        },
        buttons: {
          type: "stack",
          props: { direction: "horizontal" },
          children: [
            "btn-sprint",
            "btn-monthly-grind",
            "btn-builders-block",
            "btn-beast-mode",
          ],
        },
        "btn-sprint": {
          type: "button",
          props: { label: "sprint" },
          on: {
            press: {
              action: "submit",
              params: { target: `${base}/?action=select-template&t=sprint` },
            },
          },
        },
        "btn-monthly-grind": {
          type: "button",
          props: { label: "monthly grind" },
          on: {
            press: {
              action: "submit",
              params: {
                target: `${base}/?action=select-template&t=monthly-grind`,
              },
            },
          },
        },
        "btn-builders-block": {
          type: "button",
          props: { label: "builders block" },
          on: {
            press: {
              action: "submit",
              params: {
                target: `${base}/?action=select-template&t=builders-block`,
              },
            },
          },
        },
        "btn-beast-mode": {
          type: "button",
          props: { label: "beast mode" },
          on: {
            press: {
              action: "submit",
              params: {
                target: `${base}/?action=select-template&t=beast-mode`,
              },
            },
          },
        },
      },
    },
  };
}

function renderTier(template: string, base: string) {
  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: {},
          children: [
            "title",
            "subtitle",
            "tier-starter",
            "tier-standard",
            "tier-serious",
            "tier-allin",
            "back-btn",
          ],
        },
        title: {
          type: "text",
          props: { content: "how much are you putting up?", weight: "bold" },
        },
        subtitle: {
          type: "text",
          props: { content: `${template} selected`, size: "sm" },
        },
        "tier-starter": {
          type: "item",
          props: {
            title: "starter",
            description: TIER_META["starter"].description,
          },
          children: ["pick-starter"],
        },
        "tier-standard": {
          type: "item",
          props: {
            title: "standard",
            description: TIER_META["standard"].description,
          },
          children: ["pick-standard"],
        },
        "tier-serious": {
          type: "item",
          props: {
            title: "serious",
            description: TIER_META["serious"].description,
          },
          children: ["pick-serious"],
        },
        "tier-allin": {
          type: "item",
          props: {
            title: "all-in",
            description: TIER_META["all-in"].description,
          },
          children: ["pick-allin"],
        },
        "back-btn": {
          type: "button",
          props: { label: "back" },
          on: {
            press: {
              action: "submit",
              params: { target: `${base}/?action=back` },
            },
          },
        },
        "pick-starter": {
          type: "button",
          props: { label: "pick" },
          on: {
            press: {
              action: "submit",
              params: {
                target: `${base}/?action=select-tier&tier=starter`,
              },
            },
          },
        },
        "pick-standard": {
          type: "button",
          props: { label: "pick" },
          on: {
            press: {
              action: "submit",
              params: {
                target: `${base}/?action=select-tier&tier=standard`,
              },
            },
          },
        },
        "pick-serious": {
          type: "button",
          props: { label: "pick" },
          on: {
            press: {
              action: "submit",
              params: {
                target: `${base}/?action=select-tier&tier=serious`,
              },
            },
          },
        },
        "pick-allin": {
          type: "button",
          props: { label: "pick" },
          on: {
            press: {
              action: "submit",
              params: {
                target: `${base}/?action=select-tier&tier=all-in`,
              },
            },
          },
        },
      },
    },
  };
}

async function renderConfirm(
  template: string,
  tier: string,
  fid: number | undefined,
  base: string
) {
  const tmpl = TEMPLATE_META[template] ?? { duration: 7, proofs: 3 };
  const tierData = TIER_META[tier] ?? { amount: 5_000, description: "" };

  let socialText: string | null = null;
  if (fid !== undefined) {
    try {
      const res = await fetch(
        `${process.env.RAILWAY_URL}/api/snap/social?fid=${fid}`
      );
      if (res.ok) {
        const social = (await res.json()) as {
          followingActive: number;
          names: string[];
        };
        if (social.followingActive > 0) {
          socialText = `${social.followingActive} ${social.followingActive === 1 ? "person" : "people"} you follow ${social.followingActive === 1 ? "is" : "are"} active`;
        }
      }
    } catch {
      // no social context, continue
    }
  }

  const rootChildren = [
    "title",
    "meta",
    "fee",
    ...(socialText ? ["social"] : []),
    "lock-btn",
    "reset-btn",
  ];

  const elements: Record<string, SnapElementInput> = {
    page: {
      type: "stack",
      props: {},
      children: rootChildren,
    },
    title: {
      type: "text",
      props: {
        content: `${template} · ${tierData.amount.toLocaleString()} $HIGHER`,
        weight: "bold",
        align: "center",
      },
    },
    meta: {
      type: "text",
      props: {
        content: `${tmpl.duration} days · ${tmpl.proofs} proofs needed`,
        size: "sm",
      },
    },
    fee: {
      type: "text",
      props: {
        content: "10% fee on completion · bonus from prize pool on pass",
        size: "sm",
      },
    },
    "lock-btn": {
      type: "button",
      props: { label: "lock it in", variant: "primary" },
      on: {
        press: {
          action: "compose_cast",
          params: {
            text: `@higherathletics commit ${template} ${tier}`,
            channelKey: "higher-athletics",
          },
        },
      },
    },
    "reset-btn": {
      type: "button",
      props: { label: "start over" },
      on: {
        press: {
          action: "submit",
          params: { target: `${base}/?action=reset` },
        },
      },
    },
  };

  if (socialText) {
    elements["social"] = {
      type: "text",
      props: { content: socialText, size: "sm" },
    };
  }

  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: { root: "page", elements },
  };
}

// ── URL helper (same as status snap) ─────────────────────────────────────────

function snapBaseUrlFromRequest(request: Request): string {
  const fromEnv = process.env.SNAP_PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  const forwardedHost = request.headers.get("x-forwarded-host");
  const hostHeader = request.headers.get("host");
  const host = (forwardedHost ?? hostHeader)?.split(",")[0].trim();
  const isLoopback =
    host !== undefined &&
    /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const proto = forwardedProto
    ? forwardedProto.split(",")[0].trim().toLowerCase()
    : isLoopback
      ? "http"
      : "https";
  if (host) return `${proto}://${host}`.replace(/\/$/, "");

  return `http://localhost:${process.env.PORT ?? "3004"}`.replace(/\/$/, "");
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono();

registerSnapHandler(app, snap, {
  openGraph: {
    title: "Higher Athletics Commit",
    description: "Pledge $HIGHER against a fitness commitment",
  },
});

export default app;
