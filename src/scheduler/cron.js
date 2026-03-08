/**
 * Cron Scheduler — wakes the agent at key moments of the day.
 *
 * The scheduler doesn't contain any logic — it just triggers the agent
 * with a natural language prompt describing what time it is and what's needed.
 */
import cron from 'node-cron';
import { runAgent, runMorningPlanning, runEveningReview } from '../agent/agent.js';

const TZ = process.env.TIMEZONE || 'Europe/London';

export function registerCronJobs() {
  const jobs = [];

  // ── 06:30 — Morning planning ──────────────────────────────────────────
  jobs.push(cron.schedule('30 6 * * *', async () => {
    console.log('[Cron] 06:30 — Triggering morning planning...');
    try {
      await runMorningPlanning();
    } catch (err) {
      console.error('[Cron] Morning planning failed:', err.message);
    }
  }, { timezone: TZ }));

  // ── 12:00 — Midday check-in ──────────────────────────────────────────
  jobs.push(cron.schedule('0 12 * * *', async () => {
    console.log('[Cron] 12:00 — Midday check-in...');
    try {
      await runAgent(
        "It's midday. Read today's plan and history. Check what's been done and what still needs to happen this afternoon. Send Max a brief midday check-in via Telegram — just 2-3 sentences, no lists."
      );
    } catch (err) {
      console.error('[Cron] Midday check-in failed:', err.message);
    }
  }, { timezone: TZ }));

  // ── 21:30 — Evening review ────────────────────────────────────────────
  jobs.push(cron.schedule('30 21 * * *', async () => {
    console.log('[Cron] 21:30 — Evening review...');
    try {
      await runEveningReview();
    } catch (err) {
      console.error('[Cron] Evening review failed:', err.message);
    }
  }, { timezone: TZ }));

  console.log(`[Cron] ${jobs.length} jobs registered (timezone: ${TZ}) ✓`);
  return jobs;
}
