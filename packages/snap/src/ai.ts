import Anthropic from "@anthropic-ai/sdk";

// ─── Pledge tiers (matches bot's COMMITMENT_TIERS) ────────────────────────────

export const TIERS: Record<
  number,
  { amount: number; tierIndex: number; tierName: string }
> = {
  15: { amount: 5_000, tierIndex: 1, tierName: "Standard" },
  30: { amount: 10_000, tierIndex: 2, tierName: "Serious" },
};

export type ParsedCommitment = {
  description: string;
  durationDays: 15 | 30;
  requiredProofs: number;
  amount: number;
  tierIndex: number;
  tierName: string;
};

export type ParseResult =
  | { ok: true; data: ParsedCommitment }
  | { ok: false; error: string };

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 3,
    });
  }
  return _client;
}

/**
 * Parse a free-text fitness goal into structured commitment parameters.
 * Duration is forced to 15 or 30 days. RequiredProofs is clamped to [1/week, 1/day].
 */
export async function parseGoal(goalText: string): Promise<ParseResult> {
  try {
    const msg = await getClient().messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      system: `Parse a fitness commitment goal into structured JSON.

Output ONLY valid JSON — no markdown, no explanation.

Success format:
{
  "ok": true,
  "description": "brief description of the commitment",
  "durationDays": 15 or 30,
  "requiredProofs": number
}

Failure format:
{ "ok": false, "error": "reason under 60 chars" }

Rules:
- Accept only physical exercise (running, cycling, gym, swimming, yoga, etc.)
- Reject non-exercise goals (reading, meditation, diet-only, etc.)
- Duration: map "2 weeks" → 15, "1 month"/"30 days" → 30; default 30 if unspecified
- requiredProofs min: ceil(durationDays / 7) — at least 1 proof per week
- requiredProofs max: durationDays — at most 1 proof per day
- "daily" or "every day" = durationDays proofs
- "Nx/week for Y weeks" = N×Y proofs (clamp to max)
- If frequency unspecified: use min (ceil(duration/7))`,
      messages: [{ role: "user", content: goalText }],
    });

    const content = msg.content[0];
    if (content.type !== "text") {
      return {
        ok: false,
        error: 'try: "run 3x/week for 30 days"',
      };
    }

    let parsed: { ok: boolean; description?: string; durationDays?: number; requiredProofs?: number; error?: string };
    try {
      const raw = content.text.trim();
      // Strip markdown code fences — Claude sometimes wraps JSON despite instructions
      const jsonText = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, error: 'try: "run 3x/week for 30 days"' };
    }

    if (!parsed.ok) {
      return { ok: false, error: parsed.error ?? "invalid goal" };
    }

    const dur = parsed.durationDays as number;
    const tier = TIERS[dur];
    if (!tier) {
      return { ok: false, error: "duration must be 15 or 30 days" };
    }

    const minProofs = Math.ceil(dur / 7);
    const maxProofs = dur;
    const proofs = Math.min(
      Math.max(parsed.requiredProofs ?? minProofs, minProofs),
      maxProofs
    );

    return {
      ok: true,
      data: {
        description: parsed.description ?? goalText.slice(0, 100),
        durationDays: dur as 15 | 30,
        requiredProofs: proofs,
        ...tier,
      },
    };
  } catch (err) {
    console.error("[snap/ai] parseGoal error:", err);
    return { ok: false, error: 'parsing failed. try: "run 3x/week for 30 days"' };
  }
}
