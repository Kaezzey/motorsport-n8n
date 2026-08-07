import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../src/config.js';
import { validateTelemetry } from '../src/validator.js';

const policy = await loadPolicy();

function buildTelemetry(mutate = (sample) => sample) {
  const samples = [];
  for (let index = 0; index < 201; index += 1) {
    const sample = {
      timestamp_ms: index * 10,
      speed_kph: 100 + index * 0.01,
      throttle_pct: 60 + Math.sin(index / 20) * 10,
      brake_pressure_bar: 0,
      steering_deg: Math.sin(index / 15) * 20,
      rpm: 6000 + index,
      gear: 4,
      longitudinal_g: 0.2 + Math.sin(index / 12) * 0.1,
      lateral_g: Math.sin(index / 15) * 0.6,
      yaw_rate_deg_s: Math.sin(index / 15) * 12,
      wheel_speed_fl_kph: 99 + index * 0.01,
      wheel_speed_fr_kph: 100 + index * 0.01,
      wheel_speed_rl_kph: 101 + index * 0.01,
      wheel_speed_rr_kph: 101 + index * 0.01,
      gps_course_deg: 90,
      gps_latitude_deg: -27.69,
      gps_longitude_deg: 152.65 + index * 0.000001
    };
    samples.push(mutate(sample, index));
  }
  return {
    schema_version: '1.0',
    session_id: 'sensor-quality-test',
    lap_id: 'lap-1',
    purpose: 'driver_coaching',
    expected_sample_rate_hz: 100,
    units: {
      timestamp_ms: 'ms', speed_kph: 'km/h', throttle_pct: '%', brake_pressure_bar: 'bar',
      steering_deg: 'deg', rpm: 'rpm', gear: 'index', longitudinal_g: 'g', lateral_g: 'g',
      yaw_rate_deg_s: 'deg/s', wheel_speed_kph: 'km/h'
    },
    provenance: { track: 'Queensland Raceway' },
    samples
  };
}

test('duration-aware frozen detection sends an active frozen yaw channel to review', () => {
  const telemetry = buildTelemetry((sample) => ({ ...sample, yaw_rate_deg_s: -27.306659169604096 }));
  const result = validateTelemetry(telemetry, policy);
  assert.equal(result.decision, 'review');
  assert.ok(result.reason_codes.includes('signals.frozen_duration'));
  assert.equal(result.sensor_quality.frozen.intervals[0].channel, 'yaw_rate_deg_s');
  assert.ok(result.sensor_quality.frozen.intervals[0].duration_ms >= 750);
});

test('an isolated sensor spike includes recovery evidence and requests review', () => {
  const telemetry = buildTelemetry((sample, index) => index === 100 ? { ...sample, lateral_g: 8 } : sample);
  const result = validateTelemetry(telemetry, policy);
  assert.equal(result.decision, 'review');
  assert.ok(result.reason_codes.includes('signals.spikes'));
  assert.equal(result.sensor_quality.spikes.events[0].recovered, true);
});

test('a recovered lap-level dropout is measured in milliseconds and requests review', () => {
  const telemetry = buildTelemetry((sample, index) => index >= 50 && index <= 60 ? { ...sample, rpm: null } : sample);
  const result = validateTelemetry(telemetry, policy);
  const dropout = result.sensor_quality.dropouts.intervals.find((interval) => interval.channel === 'rpm');
  assert.equal(result.decision, 'review');
  assert.equal(dropout.duration_ms, 110);
  assert.equal(dropout.recovered, true);
  assert.ok(result.reason_codes.includes('signals.dropouts'));
});

test('an impossible GPS jump requests review with distance and implied-speed evidence', () => {
  const telemetry = buildTelemetry((sample, index) => index === 100 ? { ...sample, gps_latitude_deg: -27.68 } : sample);
  const result = validateTelemetry(telemetry, policy);
  assert.equal(result.decision, 'review');
  assert.ok(result.reason_codes.includes('gps.validity'));
  assert.ok(result.sensor_quality.gps.metrics.jumps[0].distance_m > 1000);
  assert.ok(result.autonomy.selected_diagnostics.includes('gps_fix_investigation'));
});

test('invalid and held GPS fixes are reported separately', () => {
  const invalid = buildTelemetry((sample, index) => index === 100 ? { ...sample, gps_latitude_deg: 0, gps_longitude_deg: 0 } : sample);
  const invalidResult = validateTelemetry(invalid, policy);
  assert.equal(invalidResult.decision, 'review');
  assert.equal(invalidResult.sensor_quality.gps.metrics.invalid_fix_count, 1);

  const held = buildTelemetry((sample) => ({ ...sample, gps_latitude_deg: -27.69, gps_longitude_deg: 152.65 }));
  const heldResult = validateTelemetry(held, policy);
  assert.equal(heldResult.decision, 'review');
  assert.equal(heldResult.sensor_quality.gps.metrics.held_interval_count, 1);
  assert.equal(heldResult.sensor_quality.gps.metrics.held_intervals[0].duration_ms, 2000);
});

test('derivative limits are scaled by actual elapsed time', () => {
  const fast = buildTelemetry((sample, index) => index === 100 ? { ...sample, speed_kph: sample.speed_kph + 50 } : sample);
  const fastResult = validateTelemetry(fast, policy);
  assert.ok(fastResult.reason_codes.includes('signals.derivative_rate'));
  const violation = fastResult.sensor_quality.derivatives.violations.find((event) => event.channel === 'speed_kph');
  assert.equal(violation.elapsed_ms, 10);
  assert.ok(violation.rate_per_second > 4900);
});
