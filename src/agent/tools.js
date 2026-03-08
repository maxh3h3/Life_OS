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
import { resolve, join } from 'path';
import { format } from 'date-fns';

// DATA_DIR can be overridden by env var — used to point at Railway's
// persistent volume (/app/data) which survives redeploys and restarts.
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');

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
];

// ─── Tool Handlers (what actually runs) ───────────────────────────────────────

// Telegram send function — injected at runtime so tools.js stays DB-free
let _telegramSend = null;
export function setTelegramSender(fn) {
  _telegramSend = fn;
}

export async function executeTool(toolName, toolInput) {
  console.log(`[Agent → Tool] ${toolName}`, JSON.stringify(toolInput).slice(0, 120));

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
      return { success: true, message: `Written to ${toolInput.filename}` };
    }

    case 'list_files': {
      const files = await readdir(DATA_DIR);
      return { success: true, files };
    }

    case 'get_current_datetime': {
      const now = new Date();
      return {
        success:   true,
        iso:       now.toISOString(),
        date:      format(now, 'yyyy-MM-dd'),
        time:      format(now, 'HH:mm'),
        day:       format(now, 'EEEE'),
        timestamp: now.getTime(),
      };
    }

    case 'send_telegram': {
      if (!_telegramSend) {
        console.warn('[Tool] Telegram sender not configured — logging message instead:');
        console.log(toolInput.message);
        return { success: true, note: 'Logged to console (Telegram not configured)' };
      }
      await _telegramSend(toolInput.message, toolInput.buttons || []);
      return { success: true, message: 'Telegram message sent' };
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

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}
