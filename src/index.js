/**
 * LifeOS — Main Entry Point
 *
 * Launch mode is determined by environment variables:
 *   WEBHOOK_URL set → webhook mode (production)
 *   WEBHOOK_URL absent → long polling (local dev)
 */
import 'dotenv/config';
import { createBot } from './telegram/bot.js';
import { registerHandlers, registerBotCommands } from './telegram/handlers.js';
import { registerCronJobs } from './scheduler/cron.js';
import { startWebhookServer } from './telegram/webhook.js';

async function boot() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║         AI LIFE OPERATING SYSTEM     ║');
  console.log('║              LifeOS v2.0              ║');
  console.log('║         Agent-first architecture      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  const bot = createBot();
  registerHandlers(bot);
  registerCronJobs();
  await registerBotCommands(bot);

  process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

  const webhookUrl   = process.env.WEBHOOK_URL;
  const secretToken  = process.env.WEBHOOK_SECRET;
  const port         = parseInt(process.env.PORT || '3000', 10);

  if (webhookUrl) {
    // ── Production: webhook mode ───────────────────────────────────────
    if (!secretToken) throw new Error('WEBHOOK_SECRET is required when WEBHOOK_URL is set');

    await startWebhookServer(bot, { webhookUrl, secretToken, port });
    console.log(`[LifeOS] Webhook mode — listening on port ${port}\n`);

  } else {
    // ── Local dev: long polling ────────────────────────────────────────
    console.log('[LifeOS] Polling mode — no WEBHOOK_URL set\n');
    bot.launch();
  }
}

boot().catch((err) => {
  console.error('[LifeOS] Fatal boot error:', err);
  process.exit(1);
});
