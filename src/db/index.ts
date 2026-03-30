import 'dotenv/config';
import { Pool, types } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

// Parse PostgreSQL int8 (OID 20) as JS number.
// pg returns BIGINT columns as strings by default to avoid 64-bit overflow,
// but our FIDs and pledge amounts (max 25 000) are well within Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (val: string) => parseInt(val, 10));

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is not set. ' +
    'Copy .env.example to .env and fill in your connection string.'
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * Probe the connection at startup. Call this before opening the HTTP server
 * or starting the cron scheduler so a bad DATABASE_URL fails loudly and early.
 */
export async function initDb(): Promise<void> {
  const client = await pool.connect();
  client.release();
}

/**
 * Thin wrapper around pool.query for parameterised queries.
 * Import `pool` directly when you need transactions (pool.connect → client.query).
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}
