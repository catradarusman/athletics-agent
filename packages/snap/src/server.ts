import { serve } from "@hono/node-server";
import app from "./index.js";

/*
  Local dev only. Excluded from host.neynar.app deploys because @hono/node-server
  imports Node built-ins incompatible with the Vercel Edge runtime.
*/

const port = Number(process.env.PORT ?? "3003");
serve({ fetch: app.fetch, port });
console.log(`higher-athletics snap listening on http://localhost:${port}`);
