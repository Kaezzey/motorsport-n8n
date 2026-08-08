import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../src/config.js';
import { analyzeLapContext } from '../src/lap-context.js';
import { validateTelemetry } from '../src/validator.js';

const policy = await loadPolicy();
const profile = policy.lap_context_profile;

function buildLap({ durationMs, startSpeed, endSpeed, isFirst, isLast, referenceLabel, mutate = (sample) => sample }) {
  const intervalMs = 100;
  const sampleCount = Math.floor(durationMs / intervalMs) + 1;
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / (sampleCount - 1);
    const speed = startSpeed + (endSpeed - startSpeed) * progress;
    samples.push(mutate({
      timestamp_ms: index * intervalMs,
      speed_kph: speed,
      throttle_pct: 75,
      brake_pressure_bar: 0,
      steering_deg: Math.sin(index / 10) * 10,
      rpm: 5000 + Math.sin(index / 8) * 200,
      gear: 4,
      longitudinal_g: 0.1,
      lateral_g: Math.sin(index / 10) * 0.5,
      yaw_rate_deg_s: Math.sin(index / 10) * 5,
      wheel_speed_fl_kph: speed,
      wheel_speed_fr_kph: speed,
      wheel_speed_rl_kph: speed,
      wheel_speed_rr_kph: speed,
      gps_course_deg: 90,
      gps_latitude_deg: -27.69056,
      gps_longitude_deg: 152.65462
    }, index, sampleCount));
  }
  const provenance = {
    track: 'Queensland Raceway',
    lap_sequence: {
      lap_index: isFirst ? 1 : 2,
      source_lap_number: isFirst ? '1' : '2',
      is_first: isFirst,
      is_last: isLast,
      boundary_source: 'PDS Lap Number (-)',
      reference_label: referenceLabel,
      reference_label_origin: 'run_sequence_weak_label'
    }
  };
  return { samples, provenance };
}

test('telemetry features independently recover out, push, and in sequence labels', () => {
  const fixtures = [
    { durationMs: 92000, startSpeed: 35, endSpeed: 200, isFirst: true, isLast: false, referenceLabel: 'out_lap' },
    { durationMs: 71000, startSpeed: 200, endSpeed: 205, isFirst: false, isLast: false, referenceLabel: 'push_lap' },
    { durationMs: 92000, startSpeed: 205, endSpeed: 0, isFirst: false, isLast: true, referenceLabel: 'in_lap' }
  ];
  for (const fixture of fixtures) {
    const { samples, provenance } = buildLap(fixture);
    const result = analyzeLapContext(samples, profile, provenance);
    assert.equal(result.classification.label, fixture.referenceLabel);
    assert.equal(result.classification.passed, true);
    assert.equal(result.reference.agrees, true);
    assert.equal(result.segmentation.passed, true);
  }
});

test('the final in-lap may terminate in pit without failing the start-finish boundary gate', () => {
  const fixture = buildLap({
    durationMs: 92000, startSpeed: 205, endSpeed: 0, isFirst: false, isLast: true, referenceLabel: 'in_lap',
    mutate: (sample, index, count) => index === count - 1 ? { ...sample, gps_latitude_deg: -27.6894, gps_longitude_deg: 152.655 } : sample
  });
  const result = analyzeLapContext(fixture.samples, profile, fixture.provenance);
  assert.equal(result.segmentation.passed, true);
  assert.equal(result.segmentation.end_boundary.required, false);
  assert.ok(result.segmentation.end_boundary.distance_m > 35);
});

test('low-confidence context classification is an explicit review trigger', () => {
  const fixture = buildLap({ durationMs: 90000, startSpeed: 100, endSpeed: 100, isFirst: false, isLast: false, referenceLabel: 'push_lap' });
  const payload = {
    schema_version: '1.0', session_id: 'context-test', lap_id: 'ambiguous-lap', purpose: 'driver_coaching', expected_sample_rate_hz: 10,
    units: { timestamp_ms: 'ms', speed_kph: 'km/h', throttle_pct: '%', brake_pressure_bar: 'bar', steering_deg: 'deg', rpm: 'rpm', gear: 'index', longitudinal_g: 'g', lateral_g: 'g', yaw_rate_deg_s: 'deg/s', wheel_speed_kph: 'km/h' },
    provenance: fixture.provenance,
    samples: fixture.samples
  };
  const result = validateTelemetry(payload, policy);
  assert.equal(result.decision, 'review');
  assert.ok(result.reason_codes.includes('context.classification_confidence'));
  assert.ok(result.reason_codes.includes('context.reference_agreement'));
  assert.ok(result.autonomy.selected_diagnostics.includes('lap_classification_review'));
});

test('an unexpected sustained stop on a push lap uses the abnormal-event taxonomy', () => {
  const fixture = buildLap({
    durationMs: 71000, startSpeed: 200, endSpeed: 205, isFirst: false, isLast: false, referenceLabel: 'push_lap',
    mutate: (sample, index) => index >= 300 && index <= 330 ? { ...sample, speed_kph: 0, wheel_speed_fl_kph: 0, wheel_speed_fr_kph: 0, wheel_speed_rl_kph: 0, wheel_speed_rr_kph: 0 } : sample
  });
  const result = analyzeLapContext(fixture.samples, profile, fixture.provenance);
  assert.equal(result.abnormal_events.passed, false);
  assert.equal(result.abnormal_events.events[0].type, 'vehicle_stop');
  assert.equal(result.abnormal_events.events[0].requires_review, true);
  assert.deepEqual(result.abnormal_events.taxonomy, ['vehicle_stop', 'wheel_lock_candidate', 'wheelspin_candidate', 'course_excursion']);
});
