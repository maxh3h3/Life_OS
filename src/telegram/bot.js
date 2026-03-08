/**
 * Telegram Bot — the interface between Max and the LifeOS agent.
 *
 * Architecture shift: the bot no longer has its own logic.
 * Every message from the user is forwarded to the agent.
 * The agent decides what to do and calls send_telegram itself.
 */
import { Telegraf, Markup } from 'telegraf';
import { setTelegramSender } from '../agent/tools.js';
import { runUserMessage } from '../agent/agent.js';

let bot = null;

export function createBot() {
  if (bot) return bot;
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // Wire up the send function so the agent's send_telegram tool actually works
  setTelegramSender(async (message, buttons = []) => {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) throw new Error('TELEGRAM_CHAT_ID is required');

    const opts = { parse_mode: 'Markdown' };

    if (buttons.length > 0) {
      opts.reply_markup = Markup.inlineKeyboard(
        buttons.map(b => [Markup.button.callback(b.label, b.callback_data)])
      ).reply_markup;
    }

    await bot.telegram.sendMessage(chatId, message, opts);
  });

  return bot;
}

export function getBot() {
  if (!bot) throw new Error('Bot not initialized. Call createBot() first.');
  return bot;
}

/**
 * Direct send — for scheduler use (cron-triggered messages that bypass agent).
 */
export async function sendMessage(text, buttons = []) {
  const b = getBot();
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const opts = { parse_mode: 'Markdown' };
  if (buttons.length > 0) {
    opts.reply_markup = Markup.inlineKeyboard(
      buttons.map(btn => [Markup.button.callback(btn.label, btn.callback_data)])
    ).reply_markup;
  }
  return b.telegram.sendMessage(chatId, text, opts);
}
