import { SPEC_VERSION, type SnapFunction } from "@farcaster/snap";
import { registerSnapHandler } from "@farcaster/snap-hono";
import { Hono } from "hono";

const snap: SnapFunction = async (ctx) => {
  const base = snapBaseUrlFromRequest(ctx.request);

  return {
    version: SPEC_VERSION,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: {},
          children: ["title", "subtitle", "item-15", "item-30"],
        },
        title: {
          type: "text",
          props: { content: "start a commitment", weight: "bold" },
        },
        subtitle: {
          type: "text",
          props: { content: "higher athletics · pledge $HIGHER against your goal", size: "sm" },
        },
        "item-15": {
          type: "item",
          props: {
            title: "15 days",
            description: "5,000 $HIGHER · standard",
          },
          children: ["btn-15"],
        },
        "item-30": {
          type: "item",
          props: {
            title: "30 days",
            description: "10,000 $HIGHER · serious",
          },
          children: ["btn-30"],
        },
        "btn-15": {
          type: "button",
          props: { label: "commit", variant: "primary" },
          on: {
            press: {
              action: "compose_cast",
              params: {
                text: "@higherathletics commit run 3x a week for 15 days",
                channelKey: "higher-athletics",
              },
            },
          },
        },
        "btn-30": {
          type: "button",
          props: { label: "commit", variant: "primary" },
          on: {
            press: {
              action: "compose_cast",
              params: {
                text: "@higherathletics commit run 3x a week for 30 days",
                channelKey: "higher-athletics",
              },
            },
          },
        },
      },
    },
  };
};

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

const app = new Hono();

registerSnapHandler(app, snap, {
  openGraph: {
    title: "Higher Athletics Commit",
    description: "Pledge $HIGHER against a fitness commitment",
  },
});

export default app;
