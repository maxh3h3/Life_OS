/**
 * Logger — writes structured logs to logs/YYYY-MM-DD.log
 * and mirrors everything to console.
 *
 * Usage:
 *   import log from './logger.js';
 *   log.info('AGENT', 'Run started', { trigger: '...' });
 *   log.error('TOOL', 'write_file failed', err);
 *
 * Set LOG_LEVEL=debug in .env to enable verbose tool I/O.
 */
import { appendFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { format } from 'date-fns';

const LOGS_DIR  = process.env.LOGS_DIR || resolve(process.cwd(), 'logs');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS    = { debug: 0, info: 1, warn: 2, error: 3 };

// ─── Formatting ───────────────────────────────────────────────────────────────

function timestamp() {
  return format(new Date(), 'yyyy-MM-dd HH:mm:ss');
}

function todayFile() {
  return join(LOGS_DIR, `${format(new Date(), 'yyyy-MM-dd')}.log`);
}

/**
 * Serialize extra detail — truncate large strings so logs stay readable.
 */
function serialize(detail) {
  if (!detail) return '';
  if (detail instanceof Error) return ` | ${detail.message}`;

  const str = typeof detail === 'string'
    ? detail
    : JSON.stringify(detail, null, 0);

  // In debug mode show everything; otherwise cap at 200 chars
  return ` | ${LOG_LEVEL === 'debug' ? str : str.slice(0, 200)}`;
}

// ─── Core write ───────────────────────────────────────────────────────────────

async function write(level, tag, message, detail) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;

  const line = `[${timestamp()}] [${level.toUpperCase().padEnd(5)}] [${tag.padEnd(8)}] ${message}${serialize(detail)}\n`;

  // Console — colour-coded by level
  const colour = { debug: '\x1b[90m', info: '\x1b[0m', warn: '\x1b[33m', error: '\x1b[31m' };
  process.stdout.write(`${colour[level]}${line}\x1b[0m`);

  // File — plain text
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    await appendFile(todayFile(), line, 'utf-8');
  } catch {
    // Never let logging crash the app
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

const log = {
  debug: (tag, msg, detail) => write('debug', tag, msg, detail),
  info:  (tag, msg, detail) => write('info',  tag, msg, detail),
  warn:  (tag, msg, detail) => write('warn',  tag, msg, detail),
  error: (tag, msg, detail) => write('error', tag, msg, detail),
};

export default log;
