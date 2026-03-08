/**
 * Agent Tools — what the LifeOS agent can DO in the world.
 *
 * Each tool has two parts:
 *   1. definition  → JSON schema Claude sees (name, description, parameters)
 *   2. handler     → the actual Node.js function that executes when Claude calls it
 *
 * The agent decides WHICH tools to call and WHEN. We just provide the menu.
 */
import { readFile, writeFile, readdir } from 'fs/promises';
import log from '../logger.js';
import { resolve, join } from 'path';
import { format } from 'date-fns';

// DATA_DIR can be overridden by env var — used to point at Railway's
// persistent volume (/app/data) which survives redeploys and restarts.
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const TZ       = process.env.TZ || 'UTC';

// ─── Tool Definitions (what Claude sees) ──────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read any file from the data directory. Use this to understand the current life context, projects, plan, or history before making decisions.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'The filename to read, e.g. "context.md", "projects.json", "plan_today.json", "history.json"',
        },
      },
      required: ['filename'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the data directory. Use this to save the daily plan, update projects, append to history, or update the context.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'The filename to write, e.g. "plan_today.json", "projects.json"',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file',
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List all files currently in the data directory. Useful to see what plans or data already exist.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_current_datetime',
    description: 'Get the current date and time. Always call this first so you know what day and time it is.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_telegram',
    description: 'Send a message to the user via Telegram. Use this to deliver the daily plan, send a task reminder, or communicate any update.',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to send. You can use Telegram markdown: *bold*, _italic_, `code`.',
        },
        buttons: {
          type: 'array',
          description: 'Optional inline keyboard buttons. Each button needs a label and callback_data.',
          items: {
            type: 'object',
            properties: {
              label:         { type: 'string' },
              callback_data: { type: 'string' },
            },
            required: ['label', 'callback_data'],
          },
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'mark_task_complete',
    description: 'Mark a task from today\'s plan as complete and append it to the history log.',
    input_schema: {
      type: 'object',
      properties: {
        task_label: {
          type: 'string',
          description: 'The label of the task that was completed',
        },
        notes: {
          type: 'string',
          description: 'Any notes about how it went (optional)',
        },
      },
      required: ['task_label'],
    },
  },
  {
    name: 'save_review',
    description: 'Save the evening review text to reviews.json for permanent storage. Call this every time you complete an evening review, before or after sending it on Telegram.',
    input_schema: {
      type: 'object',
      properties: {
        review_text: {
          type: 'string',
          description: 'The full review text to store — same content you send on Telegram.',
        },
      },
      required: ['review_text'],
    },
  },
];

// ─── Tool Handlers (what actually runs) ───────────────────────────────────────

// Telegram send function — injected at runtime so tools.js stays DB-free
let _telegramSend = null;
export function setTelegramSender(fn) {
  _telegramSend = fn;
}

export async function executeTool(toolName, toolInput) {

  switch (toolName) {

    case 'read_file': {
      const path = join(DATA_DIR, toolInput.filename);
      try {
        const content = await readFile(path, 'utf-8');
        return { success: true, content };
      } catch {
        return { success: false, error: `File not found: ${toolInput.filename}` };
      }
    }

    case 'write_file': {
      const path = join(DATA_DIR, toolInput.filename);
      await writeFile(path, toolInput.content, 'utf-8');
      log.info('FILE', `Written: ${toolInput.filename} (${toolInput.content.length} chars)`);
      return { success: true, message: `Written to ${toolInput.filename}` };
    }

    case 'list_files': {
      const files = await readdir(DATA_DIR);
      return { success: true, files };
    }

    case 'get_current_datetime': {
      const now = new Date();
      const fmt = (token) => new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        ...(token === 'date'    && { year: 'numeric', month: '2-digit', day: '2-digit' }),
        ...(token === 'time'    && { hour: '2-digit', minute: '2-digit', hour12: false }),
        ...(token === 'weekday' && { weekday: 'long' }),
      }).format(now);
      return {
        success:   true,
        iso:       now.toISOString(),
        date:      fmt('date'),
        time:      fmt('time').replace(',', '').trim(),
        day:       fmt('weekday'),
        timezone:  TZ,
        timestamp: now.getTime(),
      };
    }

    case 'send_telegram': {
      if (!_telegramSend) {
        log.warn('TELEGRAM', 'Sender not configured — printing to console');
        console.log(toolInput.message);
        return { success: true, note: 'Logged to console (Telegram not configured)' };
      }
      try {
        await _telegramSend(toolInput.message, toolInput.buttons || []);
        log.info('TELEGRAM', `Sent: "${toolInput.message.slice(0, 80)}"`);
        return { success: true, message: 'Telegram message sent' };
      } catch (err) {
        log.error('TELEGRAM', 'Send failed', err);
        throw err;
      }
    }

    case 'mark_task_complete': {
      // Read current history
      const histPath = join(DATA_DIR, 'history.json');
      let history = [];
      try {
        history = JSON.parse(await readFile(histPath, 'utf-8'));
      } catch { /* first entry */ }

      history.push({
        task:        toolInput.task_label,
        notes:       toolInput.notes || '',
        completed_at: new Date().toISOString(),
        date:        format(new Date(), 'yyyy-MM-dd'),
      });

      await writeFile(histPath, JSON.stringify(history, null, 2), 'utf-8');
      return { success: true, message: `Marked complete: ${toolInput.task_label}` };
    }

    case 'save_review': {
      const { saveReview } = await import('../history.js');
      await saveReview(toolInput.review_text);
      return { success: true, message: 'Review saved to reviews.json' };
    }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}
