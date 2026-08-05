import { createHash, randomUUID } from 'node:crypto';

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);

const variance = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return mean(values.map((value) => (value - average) ** 2));
};

const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[midpoint] : (ordered[midpoint - 1] + ordered[midpoint]) / 2;
};

const finiteValues = (samples, channel) => samples
  .map((sample) => sample?.[channel])
  .filter((value) => Number.isFinite(value));

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalStringify(value)).digest('hex');
}

function classifyLap(samples) {
  const speeds = finiteValues(samples, 'speed_kph');
  const throttles = finiteValues(samples, 'throttle_pct');
  if (!speeds.length) return { label: 'unknown', confidence: 0, evidence: ['No usable speed samples'] };

  const windowSize = Math.max(1, Math.ceil(speeds.length * 0.2));
  const startSpeed = mean(speeds.slice(0, windowSize));
  const endSpeed = mean(speeds.slice(-windowSize));
  const maximumSpeed = Math.max(...speeds);
  const meanThrottle = mean(throttles);

  if (startSpeed < 50 && endSpeed - startSpeed > 35) {
    return { label: 'out_lap', confidence: 0.82, evidence: [`Speed builds from ${startSpeed.toFixed(1)} to ${endSpeed.toFixed(1)} km/h`] };
  }
  if (endSpeed < 60 && startSpeed - endSpeed > 35) {
    return { label: 'in_lap', confidence: 0.82, evidence: [`Speed falls from ${startSpeed.toFixed(1)} to ${endSpeed.toFixed(1)} km/h`] };
  }
  if (maximumSpeed > 100 && meanThrottle > 35) {
    return { label: 'push_lap', confidence: 0.76, evidence: [`Peak speed ${maximumSpeed.toFixed(1)} km/h`, `Mean throttle ${meanThrottle.toFixed(1)}%`] };
  }
  return { label: 'installation_lap', confidence: 0.6, evidence: ['No strong out-lap, in-lap, or push-lap signature'] };
}

export function validateTelemetry(payload, policy, options = {}) {
  const checks = [];
  const samples = Array.isArray(payload?.samples) ? payload.samples : [];
  const thresholds = policy.thresholds;
  const record = (id, severity, passed, summary, metrics = {}) => checks.push({ id, severity, passed, summary, metrics });

  const missingTopLevel = policy.required_top_level.filter((field) => payload?.[field] === undefined || payload?.[field] === null);
  record('schema.required', 'error', missingTopLevel.length === 0, missingTopLevel.length ? `Missing required fields: ${missingTopLevel.join(', ')}` : 'Required envelope fields are present', { missing_fields: missingTopLevel });

  const purposeAllowed = policy.allowed_purposes.includes(payload?.purpose);
  record('schema.purpose', 'error', purposeAllowed, purposeAllowed ? `Purpose ${payload.purpose} is allowed` : `Purpose must be one of: ${policy.allowed_purposes.join(', ')}`);

  const manifestReviewRequired = payload?.provenance?.manifest_review_required === true;
  record('manifest.review_required', 'warning', !manifestReviewRequired, manifestReviewRequired ? 'Upstream manifest explicitly requires human review' : 'Upstream manifest does not require review');
  const manifestMatchConfidence = payload?.provenance?.manifest_match_confidence;
  const manifestConfidencePassed = manifestMatchConfidence === undefined || manifestMatchConfidence !== 'low';
  record('manifest.match_confidence', 'warning', manifestConfidencePassed, manifestConfidencePassed ? `Manifest match confidence is ${manifestMatchConfidence ?? 'not supplied'}` : 'Upstream run matching confidence is low');

  record('samples.minimum', 'error', samples.length >= thresholds.minimum_samples, samples.length >= thresholds.minimum_samples ? `${samples.length} samples available` : `At least ${thresholds.minimum_samples} samples are required`, { sample_count: samples.length });

  const missingByChannel = {};
  let missingValues = 0;
  for (const channel of policy.required_channels) {
    const count = samples.filter((sample) => !Number.isFinite(sample?.[channel])).length;
    if (count) missingByChannel[channel] = count;
    missingValues += count;
  }
  const possibleValues = samples.length * policy.required_channels.length;
  const missingRatio = possibleValues ? missingValues / possibleValues : 1;
  const channelsPresent = samples.length > 0 && missingRatio <= thresholds.maximum_missing_ratio;
  record('channels.missing', 'error', channelsPresent, channelsPresent ? 'Required channel coverage is within policy' : `Missing-value ratio ${(missingRatio * 100).toFixed(2)}% exceeds ${(thresholds.maximum_missing_ratio * 100).toFixed(2)}%`, { missing_ratio: missingRatio, missing_by_channel: missingByChannel });

  const unitMismatches = [];
  for (const [channel, expected] of Object.entries(policy.units)) {
    if (payload?.units?.[channel] !== expected) unitMismatches.push({ channel, expected, actual: payload?.units?.[channel] ?? null });
  }
  record('units.canonical', 'error', unitMismatches.length === 0, unitMismatches.length ? `Non-canonical or missing units: ${unitMismatches.map(({ channel }) => channel).join(', ')}` : 'Channel units match the canonical schema', { mismatches: unitMismatches });

  const timestamps = finiteValues(samples, 'timestamp_ms');
  const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
  const monotonic = timestamps.length === samples.length && intervals.every((interval) => interval > 0);
  record('timestamps.monotonic', 'error', monotonic, monotonic ? 'Timestamps are strictly increasing' : 'Timestamps must be numeric and strictly increasing');

  const medianInterval = median(intervals.filter((interval) => interval > 0));
  const actualSampleRate = medianInterval ? 1000 / medianInterval : 0;
  const expectedSampleRate = Number(payload?.expected_sample_rate_hz);
  const sampleRateError = expectedSampleRate > 0 ? Math.abs(actualSampleRate - expectedSampleRate) / expectedSampleRate : 1;
  const sampleRatePassed = monotonic && expectedSampleRate > 0 && sampleRateError <= thresholds.sample_rate_tolerance_ratio;
  record('timestamps.sample_rate', 'warning', sampleRatePassed, sampleRatePassed ? `Observed sample rate ${actualSampleRate.toFixed(2)} Hz` : `Observed ${actualSampleRate.toFixed(2)} Hz differs from expected ${expectedSampleRate || 0} Hz`, { expected_hz: expectedSampleRate || 0, observed_hz: actualSampleRate, error_ratio: sampleRateError });

  const intervalJitter = intervals.length && medianInterval ? Math.sqrt(variance(intervals)) / medianInterval : 1;
  const jitterPassed = monotonic && intervalJitter <= thresholds.timestamp_jitter_ratio;
  record('timestamps.jitter', 'warning', jitterPassed, jitterPassed ? 'Timestamp jitter is within policy' : `Timestamp jitter ratio ${intervalJitter.toFixed(3)} exceeds ${thresholds.timestamp_jitter_ratio}`, { jitter_ratio: intervalJitter });

  const rangeViolations = [];
  for (const [channel, [minimum, maximum]] of Object.entries(policy.ranges)) {
    samples.forEach((sample, index) => {
      const value = sample?.[channel];
      if (Number.isFinite(value) && (value < minimum || value > maximum)) rangeViolations.push({ sample_index: index, channel, value, allowed: [minimum, maximum] });
    });
  }
  record('ranges.physical', 'error', rangeViolations.length === 0, rangeViolations.length ? `${rangeViolations.length} physical range violation(s)` : 'All numeric channels are within physical bounds', { violations: rangeViolations.slice(0, 20), total_violations: rangeViolations.length });

  const frozenCandidates = ['speed_kph', 'rpm', 'wheel_speed_fl_kph', 'wheel_speed_fr_kph', 'wheel_speed_rl_kph', 'wheel_speed_rr_kph'];
  const frozenChannels = frozenCandidates.filter((channel) => {
    const values = finiteValues(samples, channel);
    return values.length >= thresholds.minimum_samples && Math.abs(mean(values)) > 1 && variance(values) <= thresholds.frozen_variance_epsilon;
  });
  record('signals.frozen', 'warning', frozenChannels.length === 0, frozenChannels.length ? `Possible frozen signal(s): ${frozenChannels.join(', ')}` : 'No continuously active channel appears frozen', { frozen_channels: frozenChannels });

  const consecutiveSteps = (channel) => samples.slice(1).flatMap((sample, index) => {
    const previous = samples[index]?.[channel];
    const current = sample?.[channel];
    return Number.isFinite(previous) && Number.isFinite(current) ? [Math.abs(current - previous)] : [];
  });
  const speedSteps = consecutiveSteps('speed_kph');
  const rpmSteps = consecutiveSteps('rpm');
  const speedSpikes = speedSteps.filter((step) => step > thresholds.maximum_speed_step_kph).length;
  const rpmSpikes = rpmSteps.filter((step) => step > thresholds.maximum_rpm_step).length;
  record('signals.derivative', 'warning', speedSpikes === 0 && rpmSpikes === 0, speedSpikes || rpmSpikes ? `Abrupt steps detected: speed=${speedSpikes}, rpm=${rpmSpikes}` : 'Speed and RPM steps are plausible', { speed_spikes: speedSpikes, rpm_spikes: rpmSpikes });

  const wheelDeltas = samples.flatMap((sample) => ['wheel_speed_fl_kph', 'wheel_speed_fr_kph', 'wheel_speed_rl_kph', 'wheel_speed_rr_kph']
    .map((channel) => Number.isFinite(sample?.[channel]) && Number.isFinite(sample?.speed_kph) ? Math.abs(sample[channel] - sample.speed_kph) : null)
    .filter((value) => value !== null));
  const meanWheelDelta = mean(wheelDeltas);
  const wheelSpeedPassed = wheelDeltas.length > 0 && meanWheelDelta <= thresholds.maximum_wheel_speed_delta_kph;
  record('consistency.wheel_speed', 'warning', wheelSpeedPassed, wheelSpeedPassed ? 'Vehicle and wheel speeds are aligned' : `Mean wheel-speed delta ${meanWheelDelta.toFixed(1)} km/h exceeds policy`, { mean_delta_kph: meanWheelDelta });

  const brakingSamples = samples.filter((sample) => sample?.brake_pressure_bar >= thresholds.minimum_brake_pressure_bar && Number.isFinite(sample?.longitudinal_g));
  const brakingMismatchRatio = brakingSamples.length ? brakingSamples.filter((sample) => sample.longitudinal_g > thresholds.minimum_braking_deceleration_g).length / brakingSamples.length : 0;
  const brakingPassed = brakingSamples.length < 2 || brakingMismatchRatio <= 0.5;
  record('consistency.brake_deceleration', 'warning', brakingPassed, brakingPassed ? 'Brake demand and deceleration are consistent' : 'Sustained brake demand is not accompanied by deceleration', { braking_samples: brakingSamples.length, mismatch_ratio: brakingMismatchRatio });

  const steeringEvents = samples.filter((sample) => Math.abs(sample?.steering_deg) >= 5 && sample?.speed_kph >= 30 && Number.isFinite(sample?.yaw_rate_deg_s));
  const steeringYawAgreement = steeringEvents.length ? steeringEvents.filter((sample) => Math.sign(sample.steering_deg) === Math.sign(sample.yaw_rate_deg_s)).length / steeringEvents.length : 1;
  const steeringPassed = steeringEvents.length < 3 || steeringYawAgreement >= 0.6;
  record('consistency.steering_yaw', 'warning', steeringPassed, steeringPassed ? 'Steering and yaw direction are consistent' : 'Steering and yaw direction disagree', { event_count: steeringEvents.length, sign_agreement_ratio: steeringYawAgreement });

  const movingSamples = samples.filter((sample) => sample?.speed_kph > 15 && Number.isFinite(sample?.rpm) && Number.isFinite(sample?.gear));
  const rpmGearViolations = movingSamples.filter((sample) => sample.gear === 0 || sample.rpm < 700).length;
  record('consistency.rpm_speed_gear', 'warning', rpmGearViolations === 0, rpmGearViolations ? `${rpmGearViolations} moving sample(s) have implausible RPM/gear state` : 'RPM, speed, and gear states are plausible', { violation_count: rpmGearViolations });

  const hardFailures = checks.filter((check) => !check.passed && policy.hard_failure_checks.includes(check.id));
  const failedWarnings = checks.filter((check) => !check.passed && check.severity === 'warning');
  const explicitReviewTriggers = checks.filter((check) => !check.passed && policy.review_trigger_checks.includes(check.id));
  const decision = hardFailures.length ? 'reject' : explicitReviewTriggers.length || failedWarnings.length >= thresholds.warnings_before_review ? 'review' : 'accept';

  const selectedDiagnostics = ['schema_validation', 'timing_validation', 'missing_data_scan', 'physical_range_scan'];
  if (!checks.find((check) => check.id === 'signals.frozen')?.passed || !checks.find((check) => check.id === 'signals.derivative')?.passed) selectedDiagnostics.push('sensor_integrity_investigation');
  if (!wheelSpeedPassed) selectedDiagnostics.push('wheel_speed_comparison');
  if (brakingSamples.length) selectedDiagnostics.push('brake_deceleration_alignment');
  if (steeringEvents.length) selectedDiagnostics.push('steering_yaw_alignment');
  if (movingSamples.length) selectedDiagnostics.push('rpm_speed_gear_consistency');

  const runId = options.runId ?? randomUUID();
  const classification = classifyLap(samples);
  const result = {
    run_id: runId,
    evaluated_at: options.now ?? new Date().toISOString(),
    policy_id: policy.policy_id,
    input: {
      session_id: payload?.session_id ?? null,
      lap_id: payload?.lap_id ?? null,
      purpose: payload?.purpose ?? null,
      sample_count: samples.length,
      content_sha256: sha256(payload),
      provenance: payload?.provenance ?? null
    },
    autonomy: {
      mode: 'bounded_deterministic',
      selected_diagnostics: selectedDiagnostics,
      allowed_actions: ['accept', 'reject', 'request_human_review'],
      downstream_processing_authorized: decision === 'accept'
    },
    lap_classification: classification,
    decision,
    reason_codes: [...hardFailures, ...failedWarnings].map((check) => check.id),
    summary: decision === 'accept'
      ? 'Telemetry passed the configured quality gate.'
      : decision === 'reject'
        ? `Telemetry failed ${hardFailures.length} hard gate(s).`
        : `Telemetry needs human review after ${failedWarnings.length} warning(s).`,
    checks
  };
  return result;
}
