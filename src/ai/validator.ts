import Anthropic from '@anthropic-ai/sdk';
import type { Commitment } from '../db/queries.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ValidationResult {
  valid:   boolean;
  reason:  string;
  summary?: string;
}

export async function validateProof(
  commitment:             Commitment,
  castText:               string,
  imageUrls:              string[],
  previousProofSummaries: string[],
): Promise<ValidationResult> {
  const durationDays = Math.ceil(
    (commitment.end_time.getTime() - commitment.start_time.getTime()) / 86_400_000
  );
  const frequency =
    durationDays > 0
      ? `${commitment.required_proofs}x over ${durationDays} days`
      : `${commitment.required_proofs} total`;

  const systemPrompt =
    `You are the Higher Athletics proof validator. You verify whether a Farcaster cast ` +
    `constitutes legitimate proof of a physical or creative commitment.\n\n` +
    `Be fair but firm. This is about accountability, not gatekeeping.\n\n` +
    `Context:\n` +
    `- Commitment: "${commitment.template}"\n` +
    `- Required frequency: ${frequency}\n` +
    `- Proofs so far: ${commitment.verified_proofs}/${commitment.required_proofs}\n` +
    `- Previous proof summaries: [${previousProofSummaries.join(', ')}]`;

  const userPrompt =
    `User cast:\n` +
    `- Text: "${castText}"\n` +
    (imageUrls.length > 0
      ? `- Attached images: ${imageUrls.length} image(s) included above. Analyse them directly for workout evidence (Strava stats, route maps, gym photos, workout metrics, etc.).\n\n`
      : `- Attached images: none\n\n`) +
    `Rules:\n` +
    `1. The cast must show evidence of the SPECIFIC activity committed to.\n` +
    `2. Any form of physical exercise counts (running, cycling, walking, swimming, gym, yoga, etc.).\n` +
    `   Acceptable evidence: photos, tracking app screenshots (Strava, Garmin, Nike Run Club, Wahoo), specific descriptions with details (distance, time, location, reps, duration). If images are attached, read the metrics in them directly.\n` +
    `3. Generic statements ("went hard today", "did the thing") without specifics or images = INVALID.\n` +
    `4. Near-duplicate of a previous proof summary = INVALID.\n` +
    `5. Benefit of the doubt on borderline cases.\n\n` +
    `Respond ONLY with JSON, no markdown:\n` +
    `{"valid": true/false, "reason": "one line", "summary": "3-word summary"}`;

  try {
    const imageBlocks: Anthropic.ImageBlockParam[] = imageUrls.map(url => ({
      type:   'image',
      source: { type: 'url', url },
    }));

    const textBlock: Anthropic.TextBlockParam = { type: 'text', text: userPrompt };

    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 256,
      system:     systemPrompt,
      messages:   [{
        role:    'user',
        content: [...imageBlocks, textBlock],
      }],
    });

    const responseBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!responseBlock) {
      return { valid: false, reason: 'validation error' };
    }

    const parsed = JSON.parse(responseBlock.text) as { valid: boolean; reason: string; summary?: string };
    return {
      valid:   Boolean(parsed.valid),
      reason:  String(parsed.reason),
      summary: parsed.summary ? String(parsed.summary) : undefined,
    };
  } catch (err) {
    console.error('[validator] Claude API or parse error:', err);
    return { valid: false, reason: 'validation error' };
  }
}
