/**
 * Telegram Handlers — routes bot commands and messages to the agent.
 *
 * All text (commands or free chat) ultimately reaches the agent.
 * The agent replies via its send_telegram tool — so responses are
 * always sent to TELEGRAM_CHAT_ID, not back through ctx.reply.
 * (This is a single-user personal bot, so that's fine.)
 */
import { runAgent, runMorningPlanning, runEveningQuestion, runEveningReviewWithResponse } from '../agent/agent.js';
import { markDone, markSkipped, consumePendingQuestion } from '../history.js';

/**
 * Reject any message not coming from the authorised chat ID.
 * This is a personal bot — no one else should be able to trigger the agent.
 */
function isAuthorised(ctx) {
  const allowed = process.env.TELEGRAM_CHAT_ID;
  const incoming = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || '');
  return incoming === allowed;
}

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
/**
 * Run an agent call with typing indicator.
 * Pass either a trigger string OR a pre-built async function.
 */
async function withAgent(ctx, triggerMessage, agentFn = null) {
  const stopTyping = startTypingIndicator(ctx);
  try {
    if (agentFn) {
      await agentFn();
    } else {
      await runAgent(triggerMessage);
    }
  } catch (err) {
    console.error('[Handler] Agent error:', err.message);
    await ctx.reply(`⚠️ Agent error: ${err.message}`);
  } finally {
    stopTyping();
  }
}

export function registerHandlers(bot) {

  // ── Auth middleware — runs before every handler ─────────────────────────
  // Silently drops any update not from the authorised chat ID.
  bot.use(async (ctx, next) => {
    if (!isAuthorised(ctx)) {
      console.warn(`[Auth] Blocked message from chat_id: ${ctx.chat?.id}`);
      return; // do not call next() — handler chain stops here
    }
    return next();
  });

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
    const { setPendingQuestion } = await import('../history.js');
    await withAgent(ctx, null, async () => {
      await runEveningQuestion();
      await setPendingQuestion('evening_review');
    });
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

  // ── Free text — check pending question first, then fall through to agent ─
  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    // Check if this reply is answering a pending question
    const pending = await consumePendingQuestion();

    if (pending?.type === 'evening_review') {
      console.log(`[Telegram → Agent 2] Evening review response: "${text}"`);
      await withAgent(ctx, null, () => runEveningReviewWithResponse(text));
      return;
    }

    // Generic message — let the agent figure it out
    console.log(`[Telegram → Agent] "${text}"`);
    await withAgent(ctx,
      `The user sent this message: "${text}". ` +
      `Understand what they need — it might be marking a task done, asking for advice, adding context, requesting a plan update, or just chatting. ` +
      `Take appropriate action (read/write files if needed) and respond on Telegram.`
    );
  });

  // ── Inline button callbacks ────────────────────────────────────────────
  // Handles task check-in responses: "done::08:00::Morning run" or "skip::08:00::Morning run"
  // Also handles any other generic button presses.
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery('Got it ✓');

    console.log(`[Telegram → Agent] Button: "${data}"`);

    // Parse structured check-in responses — no agent needed, just write to file
    if (data.startsWith('done::') || data.startsWith('skip::')) {
      const [action, time, ...taskParts] = data.split('::');
      const taskName = taskParts.join('::');

      if (action === 'done') {
        await markDone(taskName, time);
        await ctx.reply(`✅ Logged: *${taskName}*`, { parse_mode: 'Markdown' });
      } else {
        await markSkipped(taskName, time);
        await ctx.reply(`❌ Noted: *${taskName}* skipped`, { parse_mode: 'Markdown' });
      }
      return;
    }

    // Generic button press — let the agent figure it out
    await withAgent(ctx,
      `The user pressed a button with value: "${data}". Process this appropriately and respond on Telegram.`
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
