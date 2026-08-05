import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAuditEvent, listAuditEvents, verifyAuditLog } from '../src/audit-log.js';

test('audit events form a verifiable hash chain', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-audit-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');

  const first = await appendAuditEvent(path, { event_type: 'telemetry_evaluated', run_id: 'run-1' });
  const second = await appendAuditEvent(path, { event_type: 'human_override_recorded', run_id: 'run-1' });
  const events = await listAuditEvents(path);
  const verification = await verifyAuditLog(path);

  assert.equal(events.length, 2);
  assert.equal(second.previous_hash, first.event_hash);
  assert.deepEqual(verification, { valid: true, event_count: 2, errors: [] });
});

test('concurrent events are serialized into one valid chain', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-audit-concurrency-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');

  await Promise.all(Array.from({ length: 8 }, (_, index) => appendAuditEvent(path, {
    event_type: 'telemetry_evaluated',
    run_id: `run-${index}`
  })));

  const events = await listAuditEvents(path);
  const verification = await verifyAuditLog(path);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(verification.valid, true);
});
