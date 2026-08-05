import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalStringify, sha256 } from './validator.js';

const writeQueues = new Map();

async function readEvents(path) {
  try {
    const content = await readFile(path, 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendAuditEventUnlocked(path, event) {
  await mkdir(dirname(path), { recursive: true });
  const events = await readEvents(path);
  const previous = events.at(-1);
  const chained = {
    sequence: (previous?.sequence ?? 0) + 1,
    previous_hash: previous?.event_hash ?? null,
    ...event
  };
  const complete = { ...chained, event_hash: sha256(canonicalStringify(chained)) };
  await appendFile(path, `${JSON.stringify(complete)}\n`, 'utf8');
  return complete;
}

export async function appendAuditEvent(path, event) {
  const previousWrite = writeQueues.get(path) ?? Promise.resolve();
  const nextWrite = previousWrite.catch(() => {}).then(() => appendAuditEventUnlocked(path, event));
  writeQueues.set(path, nextWrite);
  try {
    return await nextWrite;
  } finally {
    if (writeQueues.get(path) === nextWrite) writeQueues.delete(path);
  }
}

export async function listAuditEvents(path) {
  return readEvents(path);
}

export async function verifyAuditLog(path) {
  const events = await readEvents(path);
  const errors = [];
  events.forEach((event, index) => {
    const { event_hash: eventHash, ...unsigned } = event;
    const expectedPrevious = index === 0 ? null : events[index - 1].event_hash;
    if (event.previous_hash !== expectedPrevious) errors.push({ sequence: event.sequence, problem: 'previous_hash mismatch' });
    if (sha256(canonicalStringify(unsigned)) !== eventHash) errors.push({ sequence: event.sequence, problem: 'event_hash mismatch' });
  });
  return { valid: errors.length === 0, event_count: events.length, errors };
}
