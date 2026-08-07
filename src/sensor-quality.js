const finite = (value) => Number.isFinite(value);

function activeFor(sample, conditions = {}) {
  return Object.entries(conditions).every(([channel, limits]) => {
    const value = sample?.[channel];
    if (!finite(value)) return false;
    if (finite(limits.minimum) && value < limits.minimum) return false;
    if (finite(limits.maximum) && value > limits.maximum) return false;
    if (finite(limits.minimum_abs) && Math.abs(value) < limits.minimum_abs) return false;
    return true;
  });
}

function boundedPush(items, value, maximum = 20) {
  if (items.length < maximum) items.push(value);
}

function frozenIntervals(samples, configuration) {
  const intervals = [];
  let totalCount = 0;
  const countsByChannel = {};
  for (const [channel, rules] of Object.entries(configuration ?? {})) {
    let run = null;
    const close = (endIndex) => {
      if (!run || endIndex < run.start_index) {
        run = null;
        return;
      }
      const endTimestamp = samples[endIndex]?.timestamp_ms;
      const durationMs = finite(endTimestamp) ? endTimestamp - run.start_timestamp_ms : 0;
      if (durationMs >= rules.minimum_duration_ms) {
        totalCount += 1;
        countsByChannel[channel] = (countsByChannel[channel] ?? 0) + 1;
        boundedPush(intervals, {
          channel,
          start_index: run.start_index,
          end_index: endIndex,
          start_timestamp_ms: run.start_timestamp_ms,
          end_timestamp_ms: endTimestamp,
          duration_ms: durationMs,
          value: run.value
        });
      }
      run = null;
    };

    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const value = sample?.[channel];
      const active = finite(value) && finite(sample?.timestamp_ms) && activeFor(sample, rules.active_when);
      if (!active) {
        close(index - 1);
        continue;
      }
      if (!run) {
        run = { start_index: index, start_timestamp_ms: sample.timestamp_ms, value, previous: value };
      } else if (Math.abs(value - run.previous) <= rules.epsilon) {
        run.previous = value;
      } else {
        close(index - 1);
        run = { start_index: index, start_timestamp_ms: sample.timestamp_ms, value, previous: value };
      }
    }
    close(samples.length - 1);
  }
  return { intervals, total_count: totalCount, counts_by_channel: countsByChannel, evidence_truncated: totalCount > intervals.length };
}

function derivativeDiagnostics(samples, limits) {
  const violations = [];
  let totalViolations = 0;
  const countsByChannel = {};
  const maximumAbsRateByChannel = {};
  for (const [channel, maximumRate] of Object.entries(limits ?? {})) {
    let maximumObserved = 0;
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      const deltaMs = current?.timestamp_ms - previous?.timestamp_ms;
      if (!finite(previous?.[channel]) || !finite(current?.[channel]) || !finite(deltaMs) || deltaMs <= 0) continue;
      const rate = Math.abs(current[channel] - previous[channel]) / (deltaMs / 1000);
      maximumObserved = Math.max(maximumObserved, rate);
      if (rate > maximumRate) {
        totalViolations += 1;
        countsByChannel[channel] = (countsByChannel[channel] ?? 0) + 1;
        boundedPush(violations, {
          channel,
          sample_index: index,
          timestamp_ms: current.timestamp_ms,
          elapsed_ms: deltaMs,
          rate_per_second: rate,
          maximum_rate_per_second: maximumRate
        });
      }
    }
    maximumAbsRateByChannel[channel] = maximumObserved;
  }
  return { violations, total_violations: totalViolations, counts_by_channel: countsByChannel, evidence_truncated: totalViolations > violations.length, maximum_abs_rate_by_channel: maximumAbsRateByChannel };
}

function spikeDiagnostics(samples, configuration) {
  const spikes = [];
  let totalSpikes = 0;
  const countsByChannel = {};
  const maximumInterval = configuration?.maximum_neighbor_interval_ms ?? 250;
  for (const [channel, rules] of Object.entries(configuration?.channels ?? {})) {
    for (let index = 1; index < samples.length - 1; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      const next = samples[index + 1];
      const beforeMs = current?.timestamp_ms - previous?.timestamp_ms;
      const afterMs = next?.timestamp_ms - current?.timestamp_ms;
      if (![previous?.[channel], current?.[channel], next?.[channel], beforeMs, afterMs].every(finite)) continue;
      if (beforeMs <= 0 || afterMs <= 0 || beforeMs > maximumInterval || afterMs > maximumInterval) continue;
      const expected = (previous[channel] + next[channel]) / 2;
      const deviation = Math.abs(current[channel] - expected);
      const recoveryDifference = Math.abs(next[channel] - previous[channel]);
      if (deviation >= rules.minimum_deviation && recoveryDifference <= rules.maximum_recovery_difference) {
        totalSpikes += 1;
        countsByChannel[channel] = (countsByChannel[channel] ?? 0) + 1;
        boundedPush(spikes, {
          channel,
          sample_index: index,
          timestamp_ms: current.timestamp_ms,
          value: current[channel],
          expected_from_neighbors: expected,
          deviation,
          recovered: true
        });
      }
    }
  }
  return { events: spikes, total_spikes: totalSpikes, counts_by_channel: countsByChannel, evidence_truncated: totalSpikes > spikes.length };
}

function dropoutDiagnostics(samples, profile) {
  const intervals = [];
  const reviewIntervals = [];
  let totalIntervals = 0;
  let totalReviewIntervals = 0;
  const maximumEvidence = profile?.dropout_detection?.maximum_evidence_intervals ?? 20;
  const reviewDuration = profile?.dropout_detection?.minimum_review_duration_ms ?? 50;
  const recordInterval = (interval) => {
    totalIntervals += 1;
    boundedPush(intervals, interval, maximumEvidence);
    if (interval.duration_ms === null || interval.duration_ms > reviewDuration) {
      totalReviewIntervals += 1;
      boundedPush(reviewIntervals, interval, maximumEvidence);
    }
  };
  const channels = new Set([
    ...Object.keys(profile?.physical_ranges ?? {}),
    ...Object.keys(profile?.maximum_derivative_rates ?? {})
  ]);
  channels.delete('gps_course_deg');
  channels.delete('gps_latitude_deg');
  channels.delete('gps_longitude_deg');

  for (const channel of channels) {
    let open = null;
    for (let index = 0; index < samples.length; index += 1) {
      const missing = !finite(samples[index]?.[channel]);
      if (missing && !open) open = { start_index: index, start_timestamp_ms: samples[index]?.timestamp_ms ?? null };
      if (!missing && open) {
        const previousIndex = index - 1;
        const endTimestamp = samples[previousIndex]?.timestamp_ms ?? null;
        const durationMs = finite(open.start_timestamp_ms) && finite(samples[index]?.timestamp_ms)
          ? samples[index].timestamp_ms - open.start_timestamp_ms
          : null;
        recordInterval({ channel, ...open, end_index: previousIndex, end_timestamp_ms: endTimestamp, duration_ms: durationMs, recovered: true });
        open = null;
      }
    }
    if (open) {
      const endIndex = samples.length - 1;
      const endTimestamp = samples[endIndex]?.timestamp_ms ?? null;
      const durationMs = finite(open.start_timestamp_ms) && finite(endTimestamp) ? endTimestamp - open.start_timestamp_ms : null;
      recordInterval({ channel, ...open, end_index: endIndex, end_timestamp_ms: endTimestamp, duration_ms: durationMs, recovered: false });
    }
  }
  return {
    intervals,
    review_intervals: reviewIntervals,
    total_intervals: totalIntervals,
    total_review_intervals: totalReviewIntervals,
    evidence_truncated: totalIntervals > intervals.length || totalReviewIntervals > reviewIntervals.length
  };
}

function haversineMetres(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusM = 6371000;
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
}

function gpsDiagnostics(samples, rules, provenance = {}) {
  const hasGps = samples.some((sample) => sample?.gps_latitude_deg !== undefined || sample?.gps_longitude_deg !== undefined);
  if (!hasGps) return { status: 'not_available', passed: true, reason: 'GPS is optional for generic canonical inputs', metrics: {} };

  let invalidFixes = 0;
  let validFixes = 0;
  let outsideTrackEnvelope = 0;
  let held = null;
  const heldIntervals = [];
  const jumps = [];
  let totalHeldIntervals = 0;
  let totalJumps = 0;
  let previousDistinct = null;
  const trackEnvelopeApplies = rules?.track_envelope?.track_names?.includes(provenance?.track);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const latitude = sample?.gps_latitude_deg;
    const longitude = sample?.gps_longitude_deg;
    const valid = finite(latitude) && finite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      && !(latitude === 0 && longitude === 0);
    if (!valid) {
      invalidFixes += 1;
      held = null;
      continue;
    }
    validFixes += 1;
    if (trackEnvelopeApplies) {
      const [minimumLatitude, maximumLatitude] = rules.track_envelope.latitude_deg;
      const [minimumLongitude, maximumLongitude] = rules.track_envelope.longitude_deg;
      if (latitude < minimumLatitude || latitude > maximumLatitude || longitude < minimumLongitude || longitude > maximumLongitude) outsideTrackEnvelope += 1;
    }

    const moving = finite(sample.speed_kph) && sample.speed_kph >= rules.moving_speed_kph;
    if (moving && index > 0 && latitude === samples[index - 1]?.gps_latitude_deg && longitude === samples[index - 1]?.gps_longitude_deg) {
      if (!held) held = { start_index: index - 1, start_timestamp_ms: samples[index - 1]?.timestamp_ms, latitude_deg: latitude, longitude_deg: longitude };
    } else if (held) {
      const endIndex = index - 1;
      const durationMs = samples[endIndex]?.timestamp_ms - held.start_timestamp_ms;
      if (durationMs > rules.maximum_held_duration_ms_while_moving) {
        totalHeldIntervals += 1;
        boundedPush(heldIntervals, { ...held, end_index: endIndex, end_timestamp_ms: samples[endIndex]?.timestamp_ms, duration_ms: durationMs });
      }
      held = null;
    }

    if (!previousDistinct || latitude !== previousDistinct.latitude || longitude !== previousDistinct.longitude) {
      if (previousDistinct) {
        const elapsedMs = sample.timestamp_ms - previousDistinct.timestamp_ms;
        if (finite(elapsedMs) && elapsedMs > 0) {
          const distanceM = haversineMetres(previousDistinct.latitude, previousDistinct.longitude, latitude, longitude);
          const impliedSpeed = distanceM / (elapsedMs / 1000);
          if (distanceM > rules.maximum_jump_distance_m || impliedSpeed > rules.maximum_implied_speed_m_s) {
            totalJumps += 1;
            boundedPush(jumps, { sample_index: index, timestamp_ms: sample.timestamp_ms, elapsed_ms: elapsedMs, distance_m: distanceM, implied_speed_m_s: impliedSpeed });
          }
        }
      }
      previousDistinct = { latitude, longitude, timestamp_ms: sample.timestamp_ms };
    }
  }
  if (held) {
    const endIndex = samples.length - 1;
    const durationMs = samples[endIndex]?.timestamp_ms - held.start_timestamp_ms;
    if (durationMs > rules.maximum_held_duration_ms_while_moving) {
      totalHeldIntervals += 1;
      boundedPush(heldIntervals, { ...held, end_index: endIndex, end_timestamp_ms: samples[endIndex]?.timestamp_ms, duration_ms: durationMs });
    }
  }

  const totalFixes = validFixes + invalidFixes;
  const invalidRatio = totalFixes ? invalidFixes / totalFixes : 1;
  const passed = invalidRatio <= rules.maximum_invalid_fix_ratio && outsideTrackEnvelope === 0 && totalHeldIntervals === 0 && totalJumps === 0;
  return {
    status: passed ? 'valid' : 'suspect',
    passed,
    metrics: {
      valid_fix_count: validFixes,
      invalid_fix_count: invalidFixes,
      invalid_fix_ratio: invalidRatio,
      outside_track_envelope_count: outsideTrackEnvelope,
      held_interval_count: totalHeldIntervals,
      jump_count: totalJumps,
      track_envelope_applied: trackEnvelopeApplies,
      held_intervals: heldIntervals,
      jumps
    }
  };
}

export function analyzeSensorQuality(samples, profile, provenance = {}) {
  const frozen = frozenIntervals(samples, profile?.frozen_signals);
  const derivatives = derivativeDiagnostics(samples, profile?.maximum_derivative_rates);
  const spikes = spikeDiagnostics(samples, profile?.spike_detection);
  const dropouts = dropoutDiagnostics(samples, profile);
  const gps = gpsDiagnostics(samples, profile?.gps, provenance);
  return {
    profile_id: profile?.profile_id ?? 'unconfigured',
    profile_version: profile?.profile_version ?? null,
    frozen: { passed: frozen.total_count === 0, interval_count: frozen.total_count, ...frozen },
    derivatives: { passed: derivatives.total_violations === 0, violation_count: derivatives.total_violations, ...derivatives },
    spikes: { passed: spikes.total_spikes === 0, spike_count: spikes.total_spikes, ...spikes },
    dropouts: { passed: dropouts.total_review_intervals === 0, interval_count: dropouts.total_intervals, review_interval_count: dropouts.total_review_intervals, ...dropouts },
    gps
  };
}
