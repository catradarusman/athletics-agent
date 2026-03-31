import 'dotenv/config';
import express from 'express';
import { initDb } from './db/index.js';
import { webhookRouter } from './agent/webhook.js';
import { registerCronJobs } from './agent/cron.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  await initDb();
  console.log('[boot] database connected');

  const app = express();
  // Raw body for webhook signature verification — must come before express.json()
  app.use('/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(webhookRouter);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[boot] listening on port ${PORT}`);
  });

  registerCronJobs();
}

main().catch(err => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
