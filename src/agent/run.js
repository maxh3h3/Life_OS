/**
 * Standalone agent runner — use this to trigger the agent from the terminal
 * without starting the full Telegram bot.
 *
 * Usage:
 *   node src/agent/run.js "plan my day"
 *   node src/agent/run.js "I just finished my morning run"
 *   npm run agent -- "review my evening"
 */
import 'dotenv/config';
import { runAgent } from './agent.js';

const trigger = process.argv.slice(2).join(' ') || 'Plan my day';

console.log(`\nRunning agent with: "${trigger}"\n`);

runAgent(trigger)
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
