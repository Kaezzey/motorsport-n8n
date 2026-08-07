import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRunCsv } from '../src/file-validation.js';
import { canonicalUnits, channelMap, lapNumberColumn } from '../src/workbench-ingest.js';

const allHeaders = [...Object.values(channelMap), lapNumberColumn];

function buildCsv(rowCount, mutate = (row) => row) {
  const rows = [allHeaders.join(',')];
  for (let index = 0; index < rowCount; index += 1) {
    const values = Object.fromEntries(allHeaders.map((header) => [header, '1']));
    values['Time (ms)'] = String(index * 10);
    values['ecu_speed (kph)'] = String(80 + index / 100);
    values['ecu_nmot (rpm)'] = String(5000 + index);
    values['PDS Lap Number (-)'] = '1';
    const changed = mutate(values, index);
    rows.push(allHeaders.map((header) => changed[header] ?? '').join(','));
  }
  return `${rows.join('\n')}\n`;
}

async function validateFixture(context, csv, policy = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'file-validation-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'run.csv');
  await writeFile(path, csv);
  return validateRunCsv(path, {
    channelMap,
    lapNumberColumn,
    canonicalUnits,
    expectedSampleRateHz: 100,
    policy,
    sourceSha256: 'fixture-hash'
  });
}

test('full-run preflight accepts a complete 100 Hz file and records unit normalization', async (context) => {
  const report = await validateFixture(context, buildCsv(100));
  assert.equal(report.decision, 'accept');
  assert.equal(report.rows.data_rows, 100);
  assert.equal(report.timestamps.observed_hz, 100);
  assert.equal(report.timestamps.duplicate_count, 0);
  assert.equal(report.timestamps.reset_count, 0);
  assert.equal(report.channels.speed_kph.missing_count, 0);
  assert.equal(report.schema.source_to_canonical.find((entry) => entry.canonical_channel === 'speed_kph').source_unit, 'kph');
  assert.equal(report.schema.source_to_canonical.find((entry) => entry.canonical_channel === 'speed_kph').canonical_unit, 'km/h');
  assert.match(report.report_sha256, /^[a-f0-9]{64}$/);
});

test('duplicate timestamp and timestamp reset are hard file failures with segment evidence', async (context) => {
  const duplicate = await validateFixture(context, buildCsv(100, (row, index) => {
    if (index === 50) row['Time (ms)'] = '490';
    return row;
  }));
  assert.equal(duplicate.decision, 'reject');
  assert.equal(duplicate.timestamps.duplicate_count, 1);
  assert.ok(duplicate.reason_codes.includes('file.timestamps.duplicates'));

  const reset = await validateFixture(context, buildCsv(100, (row, index) => {
    if (index >= 50) row['Time (ms)'] = String((index - 50) * 10);
    return row;
  }));
  assert.equal(reset.decision, 'reject');
  assert.equal(reset.timestamps.reset_count, 1);
  assert.equal(reset.timestamps.segments.length, 2);
  assert.ok(reset.reason_codes.includes('file.timestamps.resets'));
});

test('a long but sparse channel dropout requests review and reports its interval', async (context) => {
  const report = await validateFixture(context, buildCsv(1000, (row, index) => {
    if (index >= 100 && index < 106) row['ecu_speed_fl (kph)'] = '';
    return row;
  }));
  assert.equal(report.decision, 'review');
  assert.equal(report.channels.wheel_speed_fl_kph.missing_count, 6);
  assert.equal(report.channels.wheel_speed_fl_kph.missing_ratio, 0.006);
  assert.equal(report.channels.wheel_speed_fl_kph.dropout_interval_count, 1);
  assert.equal(report.channels.wheel_speed_fl_kph.max_dropout_duration_ms, 60);
  assert.ok(report.reason_codes.includes('file.channels.dropouts'));
});

test('a timestamp gap requests review without changing the median sample rate', async (context) => {
  const report = await validateFixture(context, buildCsv(100, (row, index) => {
    if (index >= 50) row['Time (ms)'] = String(index * 10 + 100);
    return row;
  }));
  assert.equal(report.decision, 'review');
  assert.equal(report.timestamps.gap_count, 1);
  assert.equal(report.timestamps.maximum_gap_ms, 110);
  assert.equal(report.timestamps.observed_hz, 100);
  assert.ok(report.reason_codes.includes('file.timestamps.gaps'));
});
