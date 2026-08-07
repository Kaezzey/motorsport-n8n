import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestWorkbenchCollection, parseCsvLine } from '../src/workbench-ingest.js';

const headers = [
  'Time (ms)', '*yaw (deg/s)', 'ecu_aps (%)', 'ecu_nmot (rpm)', 'ecu_speed (kph)',
  'ecu_speed_fl (kph)', 'ecu_speed_fr (kph)', 'ecu_speed_rl (kph)', 'ecu_speed_rr (kph)',
  'log_acc_x (g)', 'log_acc_y (g)', 'log_asteer (deg)', 'log_dash_gear (-)',
  'log_pbrake_f (bar)', 'log_gps_course (deg)', 'log_gps_lat (deg)', 'log_gps_lon (deg)',
  'PDS Lap Number (-)'
];

function fixtureCsv() {
  const rows = [headers.join(',')];
  for (let lap = 1; lap <= 2; lap += 1) {
    for (let sample = 0; sample < 10; sample += 1) {
      const speed = 80 + sample;
      rows.push([
        ((lap - 1) * 100 + sample * 10), 1, 50, 5000 + sample * 10, speed,
        speed, speed, speed, speed, 0.1, 0.2, 2, 3, 0, 90, -27.69 + sample * 0.000001, 152.65, lap
      ].join(','));
    }
  }
  return `${rows.join('\n')}\n`;
}

async function createCollection(context, hashOverride) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-ingest-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const eventFolder = join(root, 'T01_TEST');
  const runsFolder = join(eventFolder, 'runs');
  await mkdir(runsFolder, { recursive: true });
  const csv = fixtureCsv();
  const digest = createHash('sha256').update(csv).digest('hex');
  await writeFile(join(runsFolder, 'run-1.csv'), csv);
  await writeFile(join(eventFolder, 'manifest.json'), JSON.stringify({
    kind: 'motorsport-ml/run-manifest',
    manifest_version: '1.1',
    generated_at: '2026-08-05T00:00:00',
    runs: [{
      run_id: 'EVENT::SE1::RUN 1', include: true, review_required: false,
      event: 'EVENT', event_code: 'T01', track: 'Test Circuit', session: 'SE1', run_number: 1,
      historical_data_csv_path: '/old-machine/path/run-1.csv',
      historical_data_csv_sha256: hashOverride ?? digest,
      match_confidence: 'high', setup_hash: 'setup-1'
    }]
  }));
  return root;
}

test('CSV parser handles quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsvLine('one,"two,three","four""five"'), ['one', 'two,three', 'four"five']);
});

test('Workbench collection adapter verifies, segments, maps, and hydrates laps', async (context) => {
  const root = await createCollection(context);
  const submitted = [];
  const fileReports = [];
  const report = await ingestWorkbenchCollection(root, {
    limit: 2,
    purpose: 'model_training',
    onFileReport: async (fileReport) => fileReports.push(fileReport),
    submitLap: async (payload) => {
      submitted.push(payload);
      return { decision: 'accept', run_id: `validation-${submitted.length}` };
    }
  });

  assert.equal(report.counts.accept, 2);
  assert.equal(fileReports.length, 1);
  assert.equal(fileReports[0].schema.migration.to, 'motorsport-telemetry-lap/1.0');
  assert.equal(submitted[0].samples.length, 10);
  assert.equal(submitted[0].samples[0].timestamp_ms, 0);
  assert.equal(submitted[0].samples[0].brake_pressure_bar, 0);
  assert.equal(submitted[0].samples[0].gps_course_deg, 90);
  assert.equal(submitted[0].schema_version, '1.0');
  assert.equal(submitted[0].expected_sample_rate_hz, 100);
  assert.equal(submitted[0].purpose, 'model_training');
  assert.equal(submitted[0].provenance.source_file, 'run-1.csv');
  assert.equal(submitted[0].provenance.file_validation.decision, 'accept');
  assert.match(submitted[0].provenance.file_validation.report_sha256, /^[a-f0-9]{64}$/);
  assert.equal(submitted[1].lap_id, 'EVENT::SE1::RUN 1::LAP 2');
});

test('Workbench collection adapter blocks a run with a mismatched hash', async (context) => {
  const root = await createCollection(context, '0'.repeat(64));
  const report = await ingestWorkbenchCollection(root, {
    submitLap: async () => ({ decision: 'accept' })
  });
  assert.equal(report.counts.ingestion_error, 1);
  assert.match(report.results[0].error, /SHA-256 mismatch/);
});
