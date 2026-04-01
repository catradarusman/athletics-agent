import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedCommitment {
  activity:       string;  // e.g. "cycling", "running 10k", "gym"
  description:    string;  // human-readable goal stored in DB template column
  durationDays:   number;  // 15 or 30
  requiredProofs: number;  // ≥ ceil(durationDays/7), ≤ durationDays
}

export type ParseResult =
  | { ok: true;  data: ParsedCommitment }
  | { ok: false; error: string };

// ─── Parser ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You parse fitness commitment goals from Farcaster messages into structured data.\n\n` +
  `Rules:\n` +
  `1. Only accept physical exercise goals: running, cycling, walking, swimming, gym, yoga, etc.\n` +
  `2. Reject anything that is not physical exercise (watching TV, reading, eating, etc.).\n` +
  `3. Extract: activity type, duration in days (must be exactly 15 or 30 — no other values are accepted), and required proof count.\n` +
  `4. requiredProofs must be ≥ ceil(durationDays / 7) (at least 1 per week) and ≤ durationDays (at most 1 per day).\n` +
  `5. If the user says "every day" or "daily", requiredProofs = durationDays.\n` +
  `6. If the user says "3x/week" for N weeks, requiredProofs = 3 * N.\n` +
  `7. If the user gives a one-time distance goal like "run 10k total", use 1 proof unless they say daily.\n` +
  `8. If duration is not specified or ambiguous, default to 30 days.\n` +
  `9. If the user specifies any duration other than 15 or 30 days, return ok: false with error "commitments are only available for 15 days (5,000 $HIGHER) or 30 days (10,000 $HIGHER)".\n` +
  `10. description should be a clean, concise restatement of the goal (e.g. "cycle every day for 30 days").\n\n` +
  `Respond ONLY with JSON, no markdown:\n` +
  `{"ok": true, "activity": "...", "description": "...", "durationDays": N, "requiredProofs": N}\n` +
  `or {"ok": false, "error": "one-line user-facing rejection reason"}`;

export async function parseCommitment(text: string): Promise<ParseResult> {
  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: text }],
    });

    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!block) {
      return { ok: false, error: 'could not parse your goal. try: "commit cycling every day for 2 weeks"' };
    }

    const raw = block.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(raw) as {
      ok:            boolean;
      activity?:     string;
      description?:  string;
      durationDays?: number;
      requiredProofs?: number;
      error?:        string;
    };

    if (!parsed.ok) {
      return { ok: false, error: String(parsed.error ?? 'goal must be a physical exercise commitment') };
    }

    const durationDays   = Number(parsed.durationDays);
    const requiredProofs = Number(parsed.requiredProofs);

    // Validate extracted numbers
    if (
      !parsed.activity || !parsed.description ||
      isNaN(durationDays) || (durationDays !== 15 && durationDays !== 30) ||
      isNaN(requiredProofs) || requiredProofs < Math.ceil(durationDays / 7) || requiredProofs > durationDays
    ) {
      return { ok: false, error: 'could not parse a valid commitment from that. try: "commit running 3x/week for a month"' };
    }

    return {
      ok:   true,
      data: {
        activity:       String(parsed.activity),
        description:    String(parsed.description),
        durationDays,
        requiredProofs,
      },
    };
  } catch (err) {
    console.error('[parser] error:', err);
    return { ok: false, error: 'could not parse your goal right now. try again shortly' };
  }
}
