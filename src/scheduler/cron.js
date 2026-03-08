/**
 * Cron Scheduler — wakes the agent at key moments of the day.
 *
 * Agent is only invoked when reasoning is needed.
 * Reminders and check-ins are direct Telegram sends — no agent.
 */
import cron from 'node-cron';
import { readFile, writeFile } from 'fs/promises';
import { resolve, join } from 'path';
import { format } from 'date-fns';
import { runAgent, runMorningPlanning, runEveningQuestion } from '../agent/agent.js';
import { addCheckin, wasAlreadyAsked, setPendingQuestion, clearConversation } from '../history.js';
import { sendMessage } from '../telegram/bot.js';
import log from '../logger.js';

const TZ       = process.env.TZ || 'UTC';
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const REMINDED = () => join(DATA_DIR, 'reminders.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getTodayPlan() {
  try {
    const raw = await readFile(join(DATA_DIR, 'plan_today.json'), 'utf-8');
    const plan = JSON.parse(raw);
    return Array.isArray(plan) ? plan : [];
  } catch {
    return [];
  }
}

/** Returns true if a reminder was already sent for this task today. */
async function wasAlreadyReminded(taskTime) {
  try {
    const reminded = JSON.parse(await readFile(REMINDED(), 'utf-8'));
    const today    = format(new Date(), 'yyyy-MM-dd');
    return reminded.some(r => r.date === today && r.time === taskTime);
  } catch {
    return false;
  }
}

/** Record that we sent a reminder for this task. */
async function markReminded(task) {
  let reminded = [];
  try { reminded = JSON.parse(await readFile(REMINDED(), 'utf-8')); } catch {}
  reminded.push({ date: format(new Date(), 'yyyy-MM-dd'), time: task.time, task: task.task });
  await writeFile(REMINDED(), JSON.stringify(reminded, null, 2), 'utf-8');
}

// ─── Cron actions (no agent) ──────────────────────────────────────────────────

async function sendReminder(task) {
  const text =
    `⏰ *Starting in 5 minutes*\n\n` +
    `📋 *${task.task}*\n` +
    `🕐 ${task.time} — ${task.duration_min} min\n\n` +
    `Get ready. Lock in.`;
  await sendMessage(text);
  await markReminded(task);
  log.info('CRON', `Reminder sent: "${task.task}" at ${task.time}`);
}

async function sendCheckin(task) {
  if (await wasAlreadyAsked(task.task, task.time)) return;
  await addCheckin(task.task, task.time);

  const text =
    `⏱ *Check-in*\n\n` +
    `Did you complete this?\n\n` +
    `📋 *${task.task}*\n` +
    `🕐 Scheduled: ${task.time} (${task.duration_min} min)`;

  await sendMessage(text, [
    { label: '✅ Done',    callback_data: `done::${task.time}::${task.task}` },
    { label: '❌ Skipped', callback_data: `skip::${task.time}::${task.task}` },
  ]);
  log.info('CRON', `Check-in sent: "${task.task}"`);
}

// ─── Main tick — runs every minute ───────────────────────────────────────────

async function tick() {
  const plan = await getTodayPlan();
  const now  = new Date();
  const nowM = now.getHours() * 60 + now.getMinutes();

  for (const task of plan) {
    if (!task.time) continue;
    const [h, m]  = task.time.split(':').map(Number);
    const startM  = h * 60 + m;
    const endM    = startM + (task.duration_min || 30);

    // 5-minute reminder — fire in the exact minute that is 5 min before start
    if (nowM === startM - 5) {
      if (!await wasAlreadyReminded(task.time)) {
        await sendReminder(task);
      }
    }

    // Check-in — fire in the first minute after the task ends
    if (nowM === endM) {
      await sendCheckin(task);
    }
  }
}

// ─── Register all jobs ────────────────────────────────────────────────────────

export function registerCronJobs() {
  const jobs = [];

  // ── 05:00 — Morning planning (agent) ──────────────────────────────────
  jobs.push(cron.schedule('0 5 * * *', async () => {
    console.log('[Cron] 05:00 — Morning planning...');
    try {
      await clearConversation();
      await runMorningPlanning();
    }
    catch (err) { console.error('[Cron] Morning planning failed:', err.message); }
  }, { timezone: TZ }));

  // ── 12:00 — Midday nudge (agent) ──────────────────────────────────────
  jobs.push(cron.schedule('0 12 * * *', async () => {
    console.log('[Cron] 12:00 — Midday nudge...');
    try {
      await runAgent(
        "It's midday. Read today's plan and history.json. Check what's confirmed done vs still pending. Send Max a brief 2-3 sentence nudge on Telegram."
      );
    } catch (err) { console.error('[Cron] Midday nudge failed:', err.message); }
  }, { timezone: TZ }));

  // ── Every minute — reminders + check-ins (no agent) ───────────────────
  jobs.push(cron.schedule('* * * * *', async () => {
    try { await tick(); }
    catch (err) { console.error('[Cron] Tick error:', err.message); }
  }, { timezone: TZ }));

  // ── 21:30 — Evening question, Agent 1 (agent) ─────────────────────────
  // Asks how the day went. Sets pending_question.json so the next
  // user reply is routed to Agent 2 (review writer).
  jobs.push(cron.schedule('30 21 * * *', async () => {
    console.log('[Cron] 21:30 — Evening question...');
    try {
      await runEveningQuestion();
      await setPendingQuestion('evening_review');
    } catch (err) { console.error('[Cron] Evening question failed:', err.message); }
  }, { timezone: TZ }));

  console.log(`[Cron] ${jobs.length} jobs registered (timezone: ${TZ}) ✓`);
  return jobs;
}
