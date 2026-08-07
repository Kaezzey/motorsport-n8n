import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { storeFileValidationReport } from '../src/file-report-store.js';

test('detailed file reports are stored under their content hash', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'file-report-store-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const report = { report_sha256: 'a'.repeat(64), decision: 'accept', checks: [] };
  const path = await storeFileValidationReport(report, directory);
  assert.equal(path, join(directory, `${'a'.repeat(64)}.json`));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), report);
});
