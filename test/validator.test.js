import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTelemetry } from '../src/validator.js';

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const policy = await loadJson('../config/policy.json');

test('clean push lap is accepted and authorizes downstream processing', async () => {
  const telemetry = await loadJson('../samples/clean-push-lap.json');
  const result = validateTelemetry(telemetry, policy, { runId: 'clean-test', now: '2026-08-05T00:00:00.000Z' });

  assert.equal(result.decision, 'accept');
  assert.equal(result.lap_classification.label, 'push_lap');
  assert.equal(result.autonomy.downstream_processing_authorized, true);
  assert.deepEqual(result.reason_codes, []);
  assert.ok(result.checks.every((check) => check.passed));
});

test('corrupted lap is rejected by multiple independent hard gates', async () => {
  const telemetry = await loadJson('../samples/corrupted-lap.json');
  const result = validateTelemetry(telemetry, policy, { runId: 'corrupt-test', now: '2026-08-05T00:00:00.000Z' });

  assert.equal(result.decision, 'reject');
  assert.equal(result.autonomy.downstream_processing_authorized, false);
  assert.ok(result.reason_codes.includes('units.canonical'));
  assert.ok(result.reason_codes.includes('timestamps.monotonic'));
  assert.ok(result.reason_codes.includes('ranges.physical'));
  assert.ok(result.autonomy.selected_diagnostics.includes('sensor_integrity_investigation'));
});

test('two non-hard warnings route a lap to human review', async () => {
  const telemetry = await loadJson('../samples/clean-push-lap.json');
  telemetry.expected_sample_rate_hz = 10;
  telemetry.samples = telemetry.samples.map((sample) => ({
    ...sample,
    wheel_speed_fl_kph: sample.speed_kph + 25,
    wheel_speed_fr_kph: sample.speed_kph + 25,
    wheel_speed_rl_kph: sample.speed_kph + 25,
    wheel_speed_rr_kph: sample.speed_kph + 25
  }));

  const result = validateTelemetry(telemetry, policy, { runId: 'review-test', now: '2026-08-05T00:00:00.000Z' });
  assert.equal(result.decision, 'review');
  assert.equal(result.autonomy.downstream_processing_authorized, false);
  assert.ok(result.reason_codes.includes('consistency.wheel_speed'));
  assert.ok(result.reason_codes.includes('signals.frozen') === false);
});

test('the same input has a stable content fingerprint', async () => {
  const telemetry = await loadJson('../samples/clean-push-lap.json');
  const first = validateTelemetry(telemetry, policy);
  const second = validateTelemetry(telemetry, policy);
  assert.equal(first.input.content_sha256, second.input.content_sha256);
});

test('an upstream manifest review flag always routes to human review', async () => {
  const telemetry = await loadJson('../samples/clean-push-lap.json');
  telemetry.provenance = { manifest_review_required: true, manifest_match_confidence: 'high' };
  const result = validateTelemetry(telemetry, policy);
  assert.equal(result.decision, 'review');
  assert.equal(result.autonomy.downstream_processing_authorized, false);
  assert.ok(result.reason_codes.includes('manifest.review_required'));
});

test('unsupported canonical schema versions are rejected', async () => {
  const telemetry = await loadJson('../samples/clean-push-lap.json');
  telemetry.schema_version = '2.0';
  const result = validateTelemetry(telemetry, policy);
  assert.equal(result.decision, 'reject');
  assert.ok(result.reason_codes.includes('schema.version'));
});

test('a file-level review decision cannot authorize downstream processing', async () => {
  const telemetry = await loadJson('../samples/clean-push-lap.json');
  telemetry.provenance = { file_validation: { decision: 'review', report_sha256: 'fixture' } };
  const result = validateTelemetry(telemetry, policy);
  assert.equal(result.decision, 'review');
  assert.equal(result.autonomy.downstream_processing_authorized, false);
  assert.ok(result.reason_codes.includes('file.validation_review'));
});
