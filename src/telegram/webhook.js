/**
 * Webhook Server — receives Telegram updates via HTTPS POST.
 *
 * How it works:
 *   1. We register our public URL with Telegram once at startup.
 *   2. Telegram POSTs every new message/callback to that URL.
 *   3. We verify the secret token header, then hand the body to the bot.
 *
 * Security: Telegram signs every request with X-Telegram-Bot-Api-Secret-Token.
 * We reject anything without it — so random internet traffic is ignored.
 */
import { createServer } from 'http';

const WEBHOOK_PATH = '/webhook';

/**
 * Start the webhook HTTP server.
 *
 * @param {Telegraf} bot
 * @param {object}   opts
 * @param {string}   opts.webhookUrl    - Full public HTTPS URL, e.g. https://myserver.com
 * @param {string}   opts.secretToken   - Random string shared with Telegram for request auth
 * @param {number}   opts.port          - Local port to listen on (default 3000)
 */
export async function startWebhookServer(bot, { webhookUrl, secretToken, port = 3000 }) {
  // ── 1. Tell Telegram where to send updates ──────────────────────────────
  const fullUrl = `${webhookUrl}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(fullUrl, {
    secret_token: secretToken,
  });
  console.log(`[Webhook] Registered with Telegram: ${fullUrl}`);

  // ── 2. Create HTTP server ─────────────────────────────────────────────
  const server = createServer(async (req, res) => {

    // Only handle POST to /webhook
    if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) {
      res.writeHead(404).end('Not found');
      return;
    }

    // Verify the secret token
    const incomingToken = req.headers['x-telegram-bot-api-secret-token'];
    if (incomingToken !== secretToken) {
      console.warn('[Webhook] Rejected request — invalid secret token');
      res.writeHead(401).end('Unauthorized');
      return;
    }

    // Read the request body
    let body = '';
    for await (const chunk of req) body += chunk;

    let update;
    try {
      update = JSON.parse(body);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    // Acknowledge immediately — Telegram expects 200 within 10 seconds.
    // The agent runs async after we've already replied.
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');

    // Hand the update to Telegraf's handler
    try {
      await bot.handleUpdate(update);
    } catch (err) {
      console.error('[Webhook] Error handling update:', err.message);
    }
  });

  // ── 3. Start listening ────────────────────────────────────────────────
  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`[Webhook] Server listening on port ${port}`);

  return server;
}

/**
 * Remove the webhook registration from Telegram (switches back to polling).
 */
export async function deleteWebhook(bot) {
  await bot.telegram.deleteWebhook();
  console.log('[Webhook] Webhook deleted — polling mode active');
}
