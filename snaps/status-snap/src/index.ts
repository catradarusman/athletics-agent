import { SPEC_VERSION, type SnapFunction } from "@farcaster/snap";
import { registerSnapHandler } from "@farcaster/snap-hono";
import { Hono } from "hono";

interface StatusResponse {
  found: boolean;
  username: string;
  template: string;
  verifiedProofs: number;
  requiredProofs: number;
  daysLeft: number;
  pledgeAmount: number;
  onTrack: boolean;
  lastProofAt: string | null;
}

const snap: SnapFunction = async (ctx) => {
  const fid = ctx.action.user?.fid;
  const base = snapBaseUrlFromRequest(ctx.request);

  let status: StatusResponse | null = null;
  if (fid !== undefined) {
    try {
      const res = await fetch(
        `${process.env.RAILWAY_URL}/api/snap/status?fid=${fid}`
      );
      if (res.ok) status = (await res.json()) as StatusResponse;
    } catch {
      // fall through to state1
    }
  }

  if (!status?.found) {
    return state1();
  }
  return state2(status, base);
};

function state1() {
  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: {},
          children: ["title", "subtitle", "start-btn"],
        },
        title: {
          type: "text",
          props: {
            content: "no active commitment",
            weight: "bold",
            align: "center",
          },
        },
        subtitle: {
          type: "text",
          props: {
            content: "pledge $HIGHER against a goal",
            size: "sm",
            align: "center",
          },
        },
        "start-btn": {
          type: "button",
          props: { label: "start a commitment", variant: "primary" },
          on: {
            press: {
              action: "compose_cast",
              params: {
                text: "@higherathletics commit sprint standard",
                channelKey: "higher-athletics",
              },
            },
          },
        },
      },
    },
  };
}

function state2(s: StatusResponse, base: string) {
  const remaining = s.requiredProofs - s.verifiedProofs;

  return {
    version: SPEC_VERSION,
    theme: { accent: (s.onTrack ? "green" : "amber") as "green" | "amber" },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: {},
          children: [
            "username",
            "proofs-count",
            "meta",
            "stake",
            "progress",
            "submit-proof",
            "check-pool",
          ],
        },
        username: {
          type: "text",
          props: { content: `@${s.username}`, size: "sm" },
        },
        "proofs-count": {
          type: "text",
          props: {
            content: `${s.verifiedProofs}/${s.requiredProofs} proofs`,
            weight: "bold",
            align: "center",
          },
        },
        meta: {
          type: "text",
          props: {
            content: `${s.template} · ${s.daysLeft} days left`,
            size: "sm",
          },
        },
        stake: {
          type: "text",
          props: {
            content: `${s.pledgeAmount} $HIGHER at stake`,
            size: "sm",
          },
        },
        progress: {
          type: "bar_chart",
          props: {
            bars: [
              { label: "done", value: s.verifiedProofs },
              { label: "needed", value: remaining },
            ],
          },
        },
        "submit-proof": {
          type: "button",
          props: { label: "submit proof", variant: "primary" },
          on: {
            press: {
              action: "compose_cast",
              params: {
                text: `day ${s.verifiedProofs + 1}: \n\n/higher-athletics`,
                channelKey: "higher-athletics",
              },
            },
          },
        },
        "check-pool": {
          type: "button",
          props: { label: "check pool" },
          on: {
            press: {
              action: "submit",
              params: { target: `${base}/pool` },
            },
          },
        },
      },
    },
  };
}

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

  return `http://localhost:${process.env.PORT ?? "3003"}`.replace(/\/$/, "");
}

const app = new Hono();

registerSnapHandler(app, snap, {
  openGraph: {
    title: "Higher Athletics Status",
    description: "Your current commitment progress",
  },
});

export default app;
