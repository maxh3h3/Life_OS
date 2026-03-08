/**
 * Telegram Handlers — routes bot commands and messages to the agent.
 *
 * All text (commands or free chat) ultimately reaches the agent.
 * The agent replies via its send_telegram tool — so responses are
 * always sent to TELEGRAM_CHAT_ID, not back through ctx.reply.
 * (This is a single-user personal bot, so that's fine.)
 */
import { runAgent, runMorningPlanning, runEveningReview } from '../agent/agent.js';

/**
 * Keeps the "typing…" indicator alive while the agent is working.
 * Telegram's typing action expires every ~5 seconds.
 * Returns a stop function — call it when the agent finishes.
 */
function startTypingIndicator(ctx) {
  ctx.sendChatAction('typing').catch(() => {});
  const interval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

/**
 * Wrap any agent call: show typing indicator, run agent, stop indicator.
 * On error, reply directly via ctx so the user isn't left hanging.
 */
async function withAgent(ctx, triggerMessage) {
  const stopTyping = startTypingIndicator(ctx);
  try {
    await runAgent(triggerMessage);
  } catch (err) {
    console.error('[Handler] Agent error:', err.message);
    await ctx.reply(`⚠️ Agent error: ${err.message}`);
  } finally {
    stopTyping();
  }
}

export function registerHandlers(bot) {

  // ── /start ─────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `🤖 *LifeOS Commander online*\n\n` +
      `I'm your autonomous AI life agent. I read your context, plan your days, and adapt as you go.\n\n` +
      `*Commands:*\n` +
      `/plan — Generate today's plan\n` +
      `/review — Evening review & summary\n` +
      `/projects — See your active projects\n` +
      `/add — Add something to your context\n` +
      `/help — Show this menu\n\n` +
      `*Or just talk to me freely:*\n` +
      `_"I just finished my run"_\n` +
      `_"Skip gym today, my back hurts"_\n` +
      `_"Add video idea: why I quit social media"_\n` +
      `_"What should I work on right now?"_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /help ──────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `*LifeOS Commands*\n\n` +
      `/plan — Plan today based on your context & projects\n` +
      `/review — Review what got done today\n` +
      `/projects — List active projects and their stages\n` +
      `/add [text] — Add context, e.g. /add doctor appt Thursday 10am\n` +
      `/help — This menu\n\n` +
      `Or just send any message — the agent handles it.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /plan ──────────────────────────────────────────────────────────────
  bot.command('plan', async (ctx) => {
    await withAgent(ctx,
      'Plan my day. Read my context and active projects first, then write a plan_today.json with the optimal schedule, then send the plan to me on Telegram.'
    );
  });

  // ── /review ────────────────────────────────────────────────────────────
  bot.command('review', async (ctx) => {
    await withAgent(ctx,
      "It's end of day. Read today's plan and history. Summarize what got done, what didn't, note any patterns, and send me a concise review on Telegram."
    );
  });

  // ── /projects ──────────────────────────────────────────────────────────
  bot.command('projects', async (ctx) => {
    await withAgent(ctx,
      'Read the projects.json file and send me a clear summary of all active projects and their current stages on Telegram. Be brief — one line per project.'
    );
  });

  // ── /add [context text] ────────────────────────────────────────────────
  // Usage: /add doctor appointment Thursday 10am
  bot.command('add', async (ctx) => {
    const text = ctx.message.text.replace(/^\/add\s*/i, '').trim();

    if (!text) {
      await ctx.reply(
        'Usage: `/add [what you want to add]`\n\nExamples:\n`/add doctor appointment Thursday 10am`\n`/add new video idea: morning routine`\n`/add I injured my knee, skip running this week`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await withAgent(ctx,
      `The user wants to add this to their life context: "${text}". ` +
      `Read the current context.md, figure out where this fits (upcoming events, notes, project ideas, constraints, etc.), ` +
      `update the file to include it naturally, then confirm to the user on Telegram what was added and where.`
    );
  });

  // ── Free text — forward everything to the agent ────────────────────────
  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // already handled by commands above

    console.log(`[Telegram → Agent] "${text}"`);
    await withAgent(ctx,
      `The user sent this message: "${text}". ` +
      `Understand what they need — it might be marking a task done, asking for advice, adding context, requesting a plan update, or just chatting. ` +
      `Take appropriate action (read/write files if needed) and respond on Telegram.`
    );
  });

  // ── Inline button callbacks ────────────────────────────────────────────
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery('Got it ✓');

    console.log(`[Telegram → Agent] Button: "${data}"`);
    await withAgent(ctx,
      `The user pressed a button with value: "${data}". Process this action appropriately — ` +
      `mark tasks done, update files if needed, and confirm back on Telegram.`
    );
  });

  console.log('[Telegram] Handlers registered ✓');
}

/**
 * Register slash commands with Telegram so they appear as suggestions
 * when the user types "/" in the chat. Call this once at startup.
 */
export async function registerBotCommands(bot) {
  await bot.telegram.setMyCommands([
    { command: 'plan',     description: 'Generate today\'s plan' },
    { command: 'review',   description: 'Evening review & summary' },
    { command: 'projects', description: 'List active projects' },
    { command: 'add',      description: 'Add something to your context' },
    { command: 'help',     description: 'Show all commands' },
  ]);
  console.log('[Telegram] Bot commands registered with Telegram ✓');
}
