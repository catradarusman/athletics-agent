// ─── Bot API client ───────────────────────────────────────────────────────────
// The snap calls the bot's Express server for:
//   GET  /api/commitment/:fid  — read commitment state (any status)
//   POST /api/commitment/register — create pending_onchain DB record from snap

const botUrl = () =>
  (process.env.BOT_API_URL ?? "").replace(/\/$/, "");
const secret = () => process.env.SNAP_API_SECRET ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CommitmentState =
  | { status: "none" }
  | {
      status: "pending_onchain" | "active" | "passed" | "failed" | "claimed";
      id: number;
      commitment_id: number | null;
      template: string;
      verified_proofs: number;
      required_proofs: number;
      pledge_amount: number;
      end_time: string; // ISO timestamp
      pledge_tier: string;
    };

// ─── API calls ────────────────────────────────────────────────────────────────

/** Return the latest relevant commitment for a FID from the bot DB. */
export async function getCommitmentState(fid: number): Promise<CommitmentState> {
  const url = botUrl();
  if (!url || !fid) return { status: "none" };
  try {
    const res = await fetch(`${url}/api/commitment/${fid}`, {
      headers: { "x-snap-secret": secret() },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return { status: "none" };
    return (await res.json()) as CommitmentState;
  } catch {
    return { status: "none" };
  }
}

/** Register a new commitment in the bot DB (before the onchain tx is signed). */
export async function registerCommitment(params: {
  fid: number;
  walletAddress: string;
  description: string;
  durationDays: number;
  requiredProofs: number;
  tierName: string;
  tierIndex: number;
  pledgeAmount: number;
}): Promise<{ ok: boolean; error?: string }> {
  const url = botUrl();
  if (!url) return { ok: false, error: "bot api not configured" };
  try {
    const res = await fetch(`${url}/api/commitment/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-snap-secret": secret(),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Fetch total active commitment count from bot (for pool stats). */
export async function getActiveCount(): Promise<number> {
  const url = botUrl();
  if (!url) return 0;
  try {
    const res = await fetch(`${url}/api/pool`, {
      headers: { "x-snap-secret": secret() },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as { activeCount?: number };
    return data.activeCount ?? 0;
  } catch {
    return 0;
  }
}
