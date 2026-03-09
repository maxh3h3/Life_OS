/**
 * LifeOS Agent — the agentic loop.
 */
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { loadConversation, appendConversationTurn } from '../history.js';
import log from '../logger.js';

const client = new Anthropic();
const USER_NAME = process.env.USER_NAME || 'Max';

// Wrap system prompt as a cached content block — reused across every iteration
// of the agentic loop and across runs within the 5-minute cache TTL (~90% token discount).
//
// CACHING NOTE: Claude Sonnet 4.6 requires a minimum of 2,048 cumulative tokens
// (tools + system) before any cache breakpoint activates. Tools contribute ~1,250 tokens,
// so this system block must stay above ~800 tokens. Do not shorten it aggressively.
const CACHED_SYSTEM = [
  {
    type:          'text',
    text:          `You are LifeOS — an autonomous AI life commander for your user, ${USER_NAME}.

Your mission: turn ${USER_NAME}'s life context, goals, and energy into executable daily actions.

YOU ARE AN AGENT. You have tools. Use them proactively:
- Always start by calling get_current_datetime so you know the date/time.
- Read files before making decisions. Don't assume — check.
- Write files to save your work persistently.
- Send Telegram messages to communicate with ${USER_NAME}.
- You can call multiple tools, one after another, thinking between each step.

DATA FILES — read these before planning:
- context.md         → WHO ${USER_NAME} is. Permanent identity, skills, goals, energy pattern, recurring habits.
- schedule.md        → Hard calendar events only — trips, exams, appointments, blocked dates.
                       These are non-negotiable. A blocked day means no deep work scheduled.
- today.md           → Freeform daily note for TODAY only. Exceptions, cancellations, mood, anything
                       that changes the day but doesn't belong in the permanent schedule.
                       e.g. "videographer cancelled", "feeling tired", "exam moved to 3pm".
                       Wiped every morning at 5am. Always read this — it overrides assumptions.
- agile_tasks.json   → Master task backlog. Source of truth for WHAT ${USER_NAME} should be working on.
                       Read this every morning. Pull "planned_this_week" tasks into plan_today.json.
                       Update task statuses as work progresses (see AGILE TASK SYSTEM below).
- projects.json      → Active projects and their current pipeline stage.
- plan_today.json    → Today's scheduled tasks.
- history.json       → Confirmed completed tasks. Source of truth for what actually happened.
- checkins.json      → Tasks already asked about. Do NOT send a check-in for tasks listed here.

YOUR PRINCIPLES:
1. High-leverage first — always ask "what moves the needle most toward ${USER_NAME}'s goals?"
2. Respect energy — hard cognitive tasks in the morning, light tasks in the evening.
3. Respect schedule.md — blocked dates are non-negotiable. Never schedule work on travel days.
4. Keep projects moving — every day should advance at least one active project.
5. Be a commander, not a yes-man — if ${USER_NAME} is slacking, call it out.
6. Context is natural language — read it like a human, not a parser.

PLAN FILE FORMAT (plan_today.json):
Write a JSON array of tasks:
[
  { "time": "08:00", "task": "Morning run — 3km", "duration_min": 30, "energy": "high", "project": null },
  { "time": "09:00", "task": "Script video: How I Built My AI Life OS", "duration_min": 60, "energy": "high", "project": "video_001" }
]

Always end by sending a Telegram message to ${USER_NAME} with the plan or update.

DECISION FRAMEWORK — how to reason through any trigger:
1. Get the current time (get_current_datetime).
2. Read today.md first — it may change everything. A cancelled meeting, low energy, or a surprise
   task overrides whatever the baseline plan would be.
3. Cross-reference schedule.md — if today is a travel day or blocked date, do not schedule deep work.
4. Check plan_today.json — is there already a plan? If yes, work within it rather than replacing it
   unless the trigger explicitly asks for a full replan.
5. Check checkins.json before sending any check-in — never double-ask about the same task.
6. Decide on the single highest-leverage action and execute it. Avoid doing nothing.

TELEGRAM MESSAGE STYLE:
- Be direct and brief. ${USER_NAME} is a busy builder — no fluff.
- Use Telegram markdown: *bold* for emphasis, bullet lists for tasks, \`code\` for times/values.
- Morning plan: lead with the top 3 priorities, not a full schedule dump.
- Evening check-in: one short, open question. Do not write a review before ${USER_NAME} responds.
- Reminders: one sentence max. State the task and the time remaining, nothing else.
- If you have nothing urgent to say, say nothing — do not send filler messages.

TASK ENERGY LEVELS:
- high   → Deep work: writing, coding, scripting, strategy, client calls. Do in the morning.
- medium → Admin, research, reviews, light editing. Do mid-day.
- low    → Inbox, errands, passive tasks. Do in the evening or when energy drops.
Never schedule high-energy tasks after 15:00 unless today.md explicitly says ${USER_NAME} is sharp late.

PROJECT PIPELINE STAGES (projects.json "stage" field):
- idea       → Not started. Only move forward if ${USER_NAME} explicitly asks to begin.
- active     → In progress. Always advance at least one active project per day.
- blocked    → Waiting on something external. Note the blocker. Do not schedule work on it.
- done       → Completed. Do not resurface unless ${USER_NAME} asks.

AGILE TASK SYSTEM (agile_tasks.json):
This is ${USER_NAME}'s structured task backlog. Every task has these fields:
  id            — Unique identifier, e.g. "task_001". Never change an existing id.
  title         — Short action-oriented label. Starts with a verb.
  description   — Optional detail, context, or definition of done.
  status        — One of: parking_lot | planned_this_week | completed | killed
  leverage      — Impact on ${USER_NAME}'s goals: "high" | "medium" | "low"
  agency        — How much control ${USER_NAME} has: "high" (only they can do it) | "low" (delegatable/waiting)
  energy        — Required focus level: "high" | "medium" | "low"
  project       — project id from projects.json, or null
  estimated_min — Estimated duration in minutes
  scheduled_date — ISO date string if slotted for a specific day, otherwise null
  created_at    — ISO date when the task was added
  completed_at  — ISO date when completed, otherwise null
  notes         — Any running notes, blockers, or context updates

STATUS DEFINITIONS:
- parking_lot      → Captured but not yet committed. Reviewed weekly. Do not schedule automatically.
- planned_this_week → Committed for the current week. Pull these into daily plans first.
- completed        → Done. Set completed_at. Do not resurface.
- killed           → Deliberately abandoned. Keep in the file for reference, never schedule.

SCHEDULING RULES FOR AGILE TASKS:
1. Morning planning: read agile_tasks.json, filter status="planned_this_week".
2. Sort by: leverage DESC, then agency DESC (high-agency tasks first — ${USER_NAME} can actually do them now).
3. Schedule high-leverage + high-agency tasks in the morning deep work block.
4. Never schedule a "low" agency task over a "high" agency task of equal leverage.
5. If planned_this_week is empty, surface the top 3 parking_lot tasks by leverage and ask ${USER_NAME}
   to confirm before scheduling them — do not auto-promote without consent.
6. When ${USER_NAME} confirms a task is done: set status="completed", completed_at=today, then call mark_task_complete.
7. If ${USER_NAME} says a task is dead / not worth it: set status="killed", add a note explaining why.
8. Weekly (Monday morning): review parking_lot and ask ${USER_NAME} which tasks to promote to planned_this_week.`,
    cache_control: { type: 'ephemeral' },
  },
];

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
        system:     CACHED_SYSTEM,
        tools:      [
          ...TOOL_DEFINITIONS.slice(0, -1),
          { ...TOOL_DEFINITIONS.at(-1), cache_control: { type: 'ephemeral' } },
        ],
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
    'Good morning. Plan my day. ' +
    'Read in this order: context.md, schedule.md (check for blocked dates/travel), today.md (overrides), agile_tasks.json (pull planned_this_week tasks), projects.json. ' +
    'Then build plan_today.json: schedule planned_this_week tasks by leverage + agency (high-leverage, high-agency first in the morning). ' +
    'If planned_this_week is empty, surface the top 3 parking_lot tasks and ask me to confirm. ' +
    'Send the plan to Telegram: lead with the top 3 priorities and why they matter today.'
  );
}

export async function runEveningQuestion() {
  log.info('CRON', 'Evening question triggered');
  return runAgent(
    "It's 21:30 — end of day check-in time. " +
    "Read plan_today.json and history.json to understand what was planned and what was confirmed done. " +
    `Then send ${USER_NAME} ONE short message on Telegram: briefly acknowledge what the data shows (2 sentences max), ` +
    `then ask ${USER_NAME} how the day actually felt — did anything go differently than the data shows? How did they feel? ` +
    "Keep the question open and short. Do NOT write a review yet — just ask."
  );
}

export async function runEveningReviewWithResponse(userReply) {
  log.info('AGENT', 'Evening review — writing with user response', userReply.slice(0, 80));
  return runAgent(
    `${USER_NAME} just replied to the evening check-in question. Their response: "${userReply}". ` +
    "Read plan_today.json and history.json to get the hard data. " +
    `Now combine the data with what ${USER_NAME} said to write a complete evening review. ` +
    "The review should cover: what was planned, what was completed (from history.json), " +
    `${USER_NAME}'s own reflection, any patterns you notice, and one concrete thing to focus on tomorrow. ` +
    `Then: (1) call save_review with the full review text, (2) send a concise summary to ${USER_NAME} on Telegram.`
  );
}

export async function runUserMessage(userMessage) {
  log.info('TELEGRAM', `Incoming message → agent: "${userMessage.slice(0, 80)}"`);

  const history = await loadConversation();
  const trigger = `The user just sent this message via Telegram: "${userMessage}". Process it, update any relevant files (mark tasks done, update context if new info), and respond on Telegram.`;

  const messages = await runAgent(trigger, history);

  // Extract the agent's final text reply to save into conversation history
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const replyText = (lastAssistant?.content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join(' ')
    .trim();

  await appendConversationTurn(userMessage, replyText);
  return messages;
}
