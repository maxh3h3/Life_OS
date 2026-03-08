/**
 * LifeOS Agent — the agentic loop.
 */
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import log from '../logger.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are LifeOS — an autonomous AI life commander for your user, Max.

Your mission: turn Max's life context, goals, and energy into executable daily actions.

YOU ARE AN AGENT. You have tools. Use them proactively:
- Always start by calling get_current_datetime so you know the date/time.
- Read files before making decisions. Don't assume — check.
- Write files to save your work persistently.
- Send Telegram messages to communicate with Max.
- You can call multiple tools, one after another, thinking between each step.

DATA FILES — read these before planning:
- context.md    → WHO Max is. Permanent identity, skills, goals, energy pattern.
- schedule.md   → TIME-BOUND reality. Trips, appointments, blocked dates, temporary constraints.
                  Always check this. A blocked week means no deep work tasks scheduled.
- projects.json → Active projects and their current pipeline stage.
- plan_today.json → Today's scheduled tasks.
- history.json  → Confirmed completed tasks. Source of truth for what actually happened.
- checkins.json → Tasks already asked about. Do NOT send a check-in for tasks listed here.

YOUR PRINCIPLES:
1. High-leverage first — always ask "what moves the needle most toward Max's goals?"
2. Respect energy — hard cognitive tasks in the morning, light tasks in the evening.
3. Respect schedule.md — blocked dates are non-negotiable. Never schedule work on travel days.
4. Keep projects moving — every day should advance at least one active project.
5. Be a commander, not a yes-man — if Max is slacking, call it out.
6. Context is natural language — read it like a human, not a parser.

PLAN FILE FORMAT (plan_today.json):
Write a JSON array of tasks:
[
  { "time": "08:00", "task": "Morning run — 3km", "duration_min": 30, "energy": "high", "project": null },
  { "time": "09:00", "task": "Script video: How I Built My AI Life OS", "duration_min": 60, "energy": "high", "project": "video_001" }
]

Always end by sending a Telegram message to Max with the plan or update.`;

export async function runAgent(trigger, history = []) {
  const messages  = [...history, { role: 'user', content: trigger }];
  const short     = trigger.slice(0, 80);
  let iterations  = 0;
  let totalTools  = 0;
  const MAX_ITERATIONS = 20;

  log.info('AGENT', `Run started — "${short}"`);

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      log.debug('AGENT', `Iteration ${iterations}`);

      const response = await client.messages.create({
        model:      process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096,
        system:     SYSTEM_PROMPT,
        tools:      TOOL_DEFINITIONS,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') {
        const finalText = response.content
          .filter(b => b.type === 'text').map(b => b.text).join(' ').slice(0, 120);
        log.info('AGENT', `Done — ${iterations} iterations, ${totalTools} tool calls`, finalText || undefined);
        break;
      }

      if (response.stop_reason === 'tool_use') {
        const toolCalls = response.content.filter(b => b.type === 'tool_use');
        const results   = [];

        for (const call of toolCalls) {
          totalTools++;
          // Log the call going in
          log.info('TOOL', `→ ${call.name}`, call.input);

          let result;
          try {
            result = await executeTool(call.name, call.input);
            // Log the result coming back (debug only for large payloads)
            const preview = JSON.stringify(result).slice(0, 120);
            log.debug('TOOL', `← ${call.name}`, preview);
          } catch (err) {
            log.error('TOOL', `${call.name} threw`, err);
            result = { success: false, error: err.message };
          }

          results.push({
            type:        'tool_result',
            tool_use_id: call.id,
            content:     JSON.stringify(result),
          });
        }

        messages.push({ role: 'user', content: results });
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      log.warn('AGENT', `Hit MAX_ITERATIONS (${MAX_ITERATIONS}) — force stopped`);
    }

  } catch (err) {
    log.error('AGENT', 'Uncaught error in agent loop', err);
    throw err;
  }

  return messages;
}

export async function runMorningPlanning() {
  log.info('CRON', 'Morning planning triggered');
  return runAgent(
    'Good morning. Plan my day. Read context.md, schedule.md, and projects.json first — check schedule.md carefully for any blocked dates or travel. Then write plan_today.json with the optimal schedule and send it to me on Telegram.'
  );
}

export async function runEveningQuestion() {
  log.info('CRON', 'Evening question triggered');
  return runAgent(
    "It's 21:30 — end of day check-in time. " +
    "Read plan_today.json and history.json to understand what was planned and what was confirmed done. " +
    "Then send Max ONE short message on Telegram: briefly acknowledge what the data shows (2 sentences max), " +
    "then ask him how the day actually felt — did anything go differently than the data shows? How did he feel? " +
    "Keep the question open and short. Do NOT write a review yet — just ask."
  );
}

export async function runEveningReviewWithResponse(userReply) {
  log.info('AGENT', 'Evening review — writing with user response', userReply.slice(0, 80));
  return runAgent(
    `Max just replied to the evening check-in question. His response: "${userReply}". ` +
    "Read plan_today.json and history.json to get the hard data. " +
    "Now combine the data with what Max said to write a complete evening review. " +
    "The review should cover: what was planned, what was completed (from history.json), " +
    "Max's own reflection, any patterns you notice, and one concrete thing to focus on tomorrow. " +
    "Then: (1) call save_review with the full review text, (2) send a concise summary to Max on Telegram."
  );
}

export async function runUserMessage(userMessage) {
  log.info('TELEGRAM', `Incoming message → agent: "${userMessage.slice(0, 80)}"`);
  return runAgent(
    `The user just sent this message via Telegram: "${userMessage}". Process it, update any relevant files (mark tasks done, update context if new info), and respond on Telegram.`
  );
}
