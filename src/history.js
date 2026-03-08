/**
 * History Service — direct read/write to history.json.
 * No agent involved. Just file I/O.
 */
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { format } from 'date-fns';
import log from './logger.js';

const DATA_DIR        = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const HISTORY         = () => join(DATA_DIR, 'history.json');
const CHECKINS        = () => join(DATA_DIR, 'checkins.json');
const REVIEWS         = () => join(DATA_DIR, 'reviews.json');
const PENDING         = () => join(DATA_DIR, 'pending_question.json');

async function readJSON(path, fallback = []) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

export async function markDone(taskName, scheduledTime) {
  const history = await readJSON(HISTORY());
  history.push({
    task:          taskName,
    scheduled_at:  scheduledTime,
    completed_at:  new Date().toISOString(),
    date:          format(new Date(), 'yyyy-MM-dd'),
    status:        'done',
  });
  await writeJSON(HISTORY(), history);
  log.info('HISTORY', `Done: "${taskName}"`);
}

export async function markSkipped(taskName, scheduledTime) {
  const history = await readJSON(HISTORY());
  history.push({
    task:         taskName,
    scheduled_at: scheduledTime,
    date:         format(new Date(), 'yyyy-MM-dd'),
    status:       'skipped',
  });
  await writeJSON(HISTORY(), history);
  log.info('HISTORY', `Skipped: "${taskName}"`);
}

export async function addCheckin(taskName, scheduledTime) {
  const checkins = await readJSON(CHECKINS());
  checkins.push({
    task: taskName,
    scheduled_at: scheduledTime,
    asked_at: new Date().toISOString(),
    date: format(new Date(), 'yyyy-MM-dd'),
  });
  await writeJSON(CHECKINS(), checkins);
}

export async function wasAlreadyAsked(taskName, scheduledTime) {
  const checkins = await readJSON(CHECKINS());
  return checkins.some(c => c.task === taskName && c.scheduled_at === scheduledTime);
}

// ─── Pending question state ───────────────────────────────────────────────────

/**
 * Write a pending question so the next user message knows what context it's in.
 * @param {string} type - e.g. "evening_review"
 * @param {object} context - any extra data the second agent will need
 */
export async function setPendingQuestion(type, context = {}) {
  await writeJSON(PENDING(), {
    type,
    context,
    asked_at:   new Date().toISOString(),
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  });
  log.info('STATE', `Pending question set — type: ${type}`);
}

/**
 * Read and clear the pending question in one step.
 * Returns null if none exists or if it has expired.
 */
export async function consumePendingQuestion() {
  let pending;
  try {
    pending = JSON.parse(await readFile(PENDING(), 'utf-8'));
  } catch {
    return null;
  }

  if (!pending?.type) return null;

  if (new Date() > new Date(pending.expires_at)) {
    await writeJSON(PENDING(), {});
    log.warn('STATE', `Pending question expired — type: ${pending.type}`);
    return null;
  }

  await writeJSON(PENDING(), {});
  log.info('STATE', `Pending question consumed — type: ${pending.type}`);
  return pending;
}

// ─── Conversation history ─────────────────────────────────────────────────────

const CONVERSATION_WINDOW = 10; // max messages kept (user + assistant alternating)
const CONVERSATION        = () => join(DATA_DIR, 'conversation.json');

/**
 * Load the rolling conversation history.
 * Returns an array of { role, content } plain-text messages.
 */
export async function loadConversation() {
  return readJSON(CONVERSATION(), []);
}

/**
 * Append one user↔agent exchange and trim to the last CONVERSATION_WINDOW entries.
 * @param {string} userText   - what the user sent
 * @param {string} agentReply - the agent's final text response
 */
export async function appendConversationTurn(userText, agentReply) {
  const history = await readJSON(CONVERSATION(), []);
  history.push({ role: 'user',      content: userText  });
  history.push({ role: 'assistant', content: agentReply });
  const trimmed = history.slice(-CONVERSATION_WINDOW);
  await writeJSON(CONVERSATION(), trimmed);
  log.debug('HISTORY', `Conversation: ${trimmed.length} messages in window`);
}

/** Wipe the conversation — called at 5am so each day starts fresh. */
export async function clearConversation() {
  await writeJSON(CONVERSATION(), []);
  log.info('HISTORY', 'Conversation history cleared for new day');
}

/** Wipe today.md — called at 5am alongside clearConversation. */
export async function clearDailyNote() {
  const path = join(DATA_DIR, 'today.md');
  await writeFile(path, '', 'utf-8');
  log.info('HISTORY', 'today.md cleared for new day');
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

export async function saveReview(reviewText) {
  const reviews = await readJSON(REVIEWS());
  reviews.push({
    date:        format(new Date(), 'yyyy-MM-dd'),
    saved_at:    new Date().toISOString(),
    review:      reviewText,
  });
  await writeJSON(REVIEWS(), reviews);
  console.log(`[History] Review saved for ${format(new Date(), 'yyyy-MM-dd')}`);
}
