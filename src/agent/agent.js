/**
 * LifeOS Agent — the agentic loop.
 *
 * How it works:
 *   1. We give Claude a mission (system prompt) and a trigger (user message).
 *   2. Claude reasons and calls tools autonomously.
 *   3. We execute each tool call and feed the result back to Claude.
 *   4. Claude keeps going until it decides it's done (stop_reason = 'end_turn').
 *
 * Claude is not just answering — it's operating. It reads files, writes files,
 * sends Telegram messages, and updates projects entirely on its own.
 */
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are LifeOS — an autonomous AI life commander for your user, Max.

Your mission: turn Max's life context, goals, and energy into executable daily actions.

YOU ARE AN AGENT. You have tools. Use them proactively:
- Always start by calling get_current_datetime so you know the date/time.
- Read files before making decisions. Don't assume — check.
- Write files to save your work persistently.
- Send Telegram messages to communicate with Max.
- You can call multiple tools, one after another, thinking between each step.

YOUR PRINCIPLES:
1. High-leverage first — always ask "what moves the needle most toward Max's goals?"
2. Respect energy — hard cognitive tasks in the morning, light tasks in the evening.
3. Respect fixed events — gym Mon/Wed/Fri evenings, rest on Sundays.
4. Keep projects moving — every day should advance at least one active project.
5. Be a commander, not a yes-man — if Max is slacking, call it out.
6. Context is natural language — read it like a human, not a parser.

PLAN FILE FORMAT (plan_today.json):
Write a JSON array of tasks:
[
  { "time": "08:00", "task": "Morning run — 3km building to 5km goal", "duration_min": 30, "energy": "high", "project": null },
  { "time": "09:00", "task": "Script video: How I Built My AI Life OS", "duration_min": 60, "energy": "high", "project": "video_001" }
]

Always end by sending a Telegram message to Max with the plan or update.`;

/**
 * Run the agent with a given trigger message.
 * Returns the full message history when the agent finishes.
 *
 * @param {string} trigger  - What kicks the agent off, e.g. "Plan my day" or "I just finished my run"
 * @param {Array}  history  - Optional prior conversation turns (for continuity within a session)
 */
export async function runAgent(trigger, history = []) {
  const messages = [
    ...history,
    { role: 'user', content: trigger },
  ];

  console.log(`\n[Agent] Starting with trigger: "${trigger}"`);

  let iterations = 0;
  const MAX_ITERATIONS = 20; // safety cap — prevents infinite loops

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[Agent] Iteration ${iterations}...`);

    // ── Call Claude ────────────────────────────────────────────────────────
    const response = await client.messages.create({
      model:      process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      tools:      TOOL_DEFINITIONS,
      messages,
    });

    // ── Append Claude's response to history ───────────────────────────────
    messages.push({ role: 'assistant', content: response.content });

    // ── Agent is done ─────────────────────────────────────────────────────
    if (response.stop_reason === 'end_turn') {
      const finalText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      if (finalText) console.log(`[Agent] Final thought: ${finalText}`);
      console.log(`[Agent] Done after ${iterations} iteration(s) ✓\n`);
      break;
    }

    // ── Process tool calls ─────────────────────────────────────────────────
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
      const toolResults   = [];

      for (const toolCall of toolUseBlocks) {
        const result = await executeTool(toolCall.name, toolCall.input);

        toolResults.push({
          type:        'tool_result',
          tool_use_id: toolCall.id,
          content:     JSON.stringify(result),
        });
      }

      // Feed all tool results back in a single user turn
      messages.push({ role: 'user', content: toolResults });
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    console.warn('[Agent] Hit MAX_ITERATIONS limit — stopping.');
  }

  return messages;
}

/**
 * Pre-built trigger: morning planning session.
 */
export async function runMorningPlanning() {
  return runAgent(
    'Good morning. Please plan my day. Read my context and projects first, then create a plan_today.json with the optimal schedule, then send me the plan on Telegram.'
  );
}

/**
 * Pre-built trigger: evening review.
 */
export async function runEveningReview() {
  return runAgent(
    "It's end of day. Read today's plan and history, summarize what got done, what didn't, and send me a brief review on Telegram."
  );
}

/**
 * Pre-built trigger: user sent a message (e.g. "I finished my run", "skip the gym today").
 */
export async function runUserMessage(userMessage) {
  return runAgent(
    `The user just sent this message via Telegram: "${userMessage}". Process it, update any relevant files (mark tasks done, update context if new info), and respond on Telegram.`
  );
}
