import 'dotenv/config';
import { NeynarAPIClient, Configuration } from '@neynar/nodejs-sdk';
import type { User } from '@neynar/nodejs-sdk/build/api/models/user.js';

// ─── Client ───────────────────────────────────────────────────────────────────

const config = new Configuration({
  apiKey: process.env.NEYNAR_API_KEY ?? (() => { throw new Error('NEYNAR_API_KEY is not set'); })(),
});

export const neynar = new NeynarAPIClient(config);

function getSignerUuid(): string {
  const uuid = process.env.BOT_SIGNER_UUID;
  if (!uuid) throw new Error('BOT_SIGNER_UUID is not set');
  return uuid;
}

// ─── Cast helpers ─────────────────────────────────────────────────────────────

/**
 * Reply to an existing cast by its hash.
 */
export async function castReply(parentHash: string, text: string, embedUrls?: string[]): Promise<void> {
  await neynar.publishCast({
    signerUuid: getSignerUuid(),
    text,
    parent: parentHash,
    ...(embedUrls?.length ? { embeds: embedUrls.map(url => ({ url })) } : {}),
  });
}

/**
 * Post a new cast into a channel (no parent).
 */
export async function castInChannel(text: string, channelId: string, embedUrls?: string[]): Promise<void> {
  await neynar.publishCast({
    signerUuid: getSignerUuid(),
    text,
    channelId,
    ...(embedUrls?.length ? { embeds: embedUrls.map(url => ({ url })) } : {}),
  });
}

// ─── User helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch a single user by their Farcaster ID.
 * Returns null if the FID is unknown.
 */
export async function getUserByFid(fid: number): Promise<User | null> {
  const response = await neynar.fetchBulkUsers({ fids: [fid] });
  return response.users[0] ?? null;
}
