const finite = (value) => Number.isFinite(value);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);

function haversineMetres(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusM = 6371000;
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
}

function boundedPush(items, value, maximum) {
  if (items.length < maximum) items.push(value);
}

function featureSummary(samples, rules) {
  const validTimestamps = samples.map((sample) => sample?.timestamp_ms).filter(finite);
  const endTimestamp = validTimestamps.length ? validTimestamps.at(-1) : 0;
  const durationMs = validTimestamps.length > 1 ? endTimestamp - validTimestamps[0] : 0;
  const windowMs = rules.feature_window_ms;
  const startWindow = samples.filter((sample) => finite(sample?.timestamp_ms) && sample.timestamp_ms <= windowMs);
  const endWindow = samples.filter((sample) => finite(sample?.timestamp_ms) && sample.timestamp_ms >= endTimestamp - windowMs);
  const speeds = samples.map((sample) => sample?.speed_kph).filter(finite);
  const throttles = samples.map((sample) => sample?.throttle_pct).filter(finite);
  const startSpeeds = startWindow.map((sample) => sample?.speed_kph).filter(finite);
  const endSpeeds = endWindow.map((sample) => sample?.speed_kph).filter(finite);
  return {
    duration_ms: durationMs,
    start_speed_kph: mean(startSpeeds),
    end_speed_kph: mean(endSpeeds),
    maximum_speed_kph: speeds.length ? Math.max(...speeds) : 0,
    mean_speed_kph: mean(speeds),
    mean_throttle_pct: mean(throttles),
    high_throttle_ratio: throttles.length ? throttles.filter((value) => value >= rules.push_throttle_pct).length / throttles.length : 0,
    stopped_ratio: speeds.length ? speeds.filter((value) => value <= 5).length / speeds.length : 1
  };
}

function scoreClassification(features, rules) {
  const scores = { out_lap: 0, in_lap: 0, push_lap: 0, installation_lap: 0 };
  const evidence = { out_lap: [], in_lap: [], push_lap: [], installation_lap: [] };
  const add = (label, weight, message) => {
    scores[label] += weight;
    evidence[label].push(message);
  };

  if (features.start_speed_kph < rules.slow_boundary_speed_kph) add('out_lap', 0.45, `Start-window speed ${features.start_speed_kph.toFixed(1)} km/h is below ${rules.slow_boundary_speed_kph}`);
  if (features.end_speed_kph - features.start_speed_kph >= rules.minimum_boundary_speed_change_kph) add('out_lap', 0.3, `Boundary speed increases by ${(features.end_speed_kph - features.start_speed_kph).toFixed(1)} km/h`);
  if (features.duration_ms >= rules.long_lap_duration_ms) add('out_lap', 0.15, `Lap duration ${(features.duration_ms / 1000).toFixed(2)} s is longer than the push-lap band`);
  if (features.end_speed_kph >= rules.racing_boundary_speed_kph) add('out_lap', 0.1, `End-window speed ${features.end_speed_kph.toFixed(1)} km/h is at racing pace`);

  if (features.end_speed_kph < rules.slow_boundary_speed_kph) add('in_lap', 0.45, `End-window speed ${features.end_speed_kph.toFixed(1)} km/h is below ${rules.slow_boundary_speed_kph}`);
  if (features.start_speed_kph - features.end_speed_kph >= rules.minimum_boundary_speed_change_kph) add('in_lap', 0.3, `Boundary speed falls by ${(features.start_speed_kph - features.end_speed_kph).toFixed(1)} km/h`);
  if (features.duration_ms >= rules.long_lap_duration_ms) add('in_lap', 0.15, `Lap duration ${(features.duration_ms / 1000).toFixed(2)} s is longer than the push-lap band`);
  if (features.start_speed_kph >= rules.racing_boundary_speed_kph) add('in_lap', 0.1, `Start-window speed ${features.start_speed_kph.toFixed(1)} km/h is at racing pace`);

  if (features.start_speed_kph >= rules.racing_boundary_speed_kph) add('push_lap', 0.25, 'Start-window speed is at racing pace');
  if (features.end_speed_kph >= rules.racing_boundary_speed_kph) add('push_lap', 0.25, 'End-window speed is at racing pace');
  if (features.duration_ms >= rules.push_duration_ms[0] && features.duration_ms <= rules.push_duration_ms[1]) add('push_lap', 0.25, `Duration ${(features.duration_ms / 1000).toFixed(2)} s is in the configured push-lap band`);
  if (features.maximum_speed_kph >= rules.push_peak_speed_kph) add('push_lap', 0.15, `Peak speed ${features.maximum_speed_kph.toFixed(1)} km/h exceeds the push threshold`);
  if (features.high_throttle_ratio >= rules.push_throttle_ratio) add('push_lap', 0.1, `${(features.high_throttle_ratio * 100).toFixed(1)}% of samples meet the high-throttle threshold`);

  if (features.maximum_speed_kph < rules.installation_peak_speed_kph) add('installation_lap', 0.5, 'Peak speed is below the installation-lap threshold');
  if (features.mean_speed_kph < rules.installation_mean_speed_kph) add('installation_lap', 0.25, 'Mean speed is below the installation-lap threshold');
  if (features.stopped_ratio >= 0.25) add('installation_lap', 0.25, 'At least 25% of samples are stationary');

  const ranking = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [best, runnerUp] = ranking;
  const confidence = Math.min(0.99, best[1]);
  const margin = best[1] - runnerUp[1];
  return {
    label: best[0],
    confidence,
    score_margin: margin,
    confidence_band: confidence >= 0.9 ? 'high' : confidence >= rules.minimum_confidence ? 'medium' : 'low',
    evidence: evidence[best[0]],
    features,
    scores
  };
}

function findGpsSample(samples, fromEnd = false) {
  const iterable = fromEnd ? [...samples].reverse() : samples;
  return iterable.find((sample) => finite(sample?.gps_latitude_deg) && finite(sample?.gps_longitude_deg));
}

function analyzeSegmentation(samples, profile, provenance) {
  const sequence = provenance?.lap_sequence;
  const supportedTrack = profile?.scope?.track_names?.includes(provenance?.track);
  if (!sequence || !supportedTrack) {
    return {
      status: 'not_applicable',
      passed: true,
      method: sequence?.boundary_source ?? 'canonical_payload',
      reason: sequence ? `No lap-context profile for ${provenance?.track ?? 'unknown track'}` : 'No source lap-sequence metadata supplied'
    };
  }

  const startFinish = profile.segmentation.start_finish;
  const firstGps = findGpsSample(samples);
  const lastGps = findGpsSample(samples, true);
  const startDistanceM = firstGps ? haversineMetres(firstGps.gps_latitude_deg, firstGps.gps_longitude_deg, startFinish.latitude_deg, startFinish.longitude_deg) : null;
  const endDistanceM = lastGps ? haversineMetres(lastGps.gps_latitude_deg, lastGps.gps_longitude_deg, startFinish.latitude_deg, startFinish.longitude_deg) : null;
  const durationMs = samples.length > 1 && finite(samples[0]?.timestamp_ms) && finite(samples.at(-1)?.timestamp_ms)
    ? samples.at(-1).timestamp_ms - samples[0].timestamp_ms
    : 0;
  const startPassed = finite(startDistanceM) && startDistanceM <= startFinish.radius_m;
  const endRequired = !(sequence.is_last && profile.segmentation.last_lap_may_end_in_pit);
  const endPassed = !endRequired || (finite(endDistanceM) && endDistanceM <= startFinish.radius_m);
  const durationPassed = durationMs >= profile.segmentation.minimum_lap_duration_ms && durationMs <= profile.segmentation.maximum_lap_duration_ms;
  return {
    status: startPassed && endPassed && durationPassed ? 'validated' : 'suspect',
    passed: startPassed && endPassed && durationPassed,
    method: 'source_lap_number_plus_track_geofence',
    source_lap_number: sequence.source_lap_number,
    lap_index: sequence.lap_index,
    is_first: sequence.is_first,
    is_last: sequence.is_last,
    duration_ms: durationMs,
    duration_passed: durationPassed,
    start_boundary: { required: true, distance_m: startDistanceM, radius_m: startFinish.radius_m, passed: startPassed },
    end_boundary: { required: endRequired, distance_m: endDistanceM, radius_m: startFinish.radius_m, passed: endPassed },
    pit_termination_allowed: !endRequired
  };
}

function contiguousEvents(samples, condition, minimumDurationMs, buildEvent) {
  const events = [];
  let openIndex = null;
  const close = (endIndex) => {
    if (openIndex === null || endIndex < openIndex) {
      openIndex = null;
      return;
    }
    const startTimestamp = samples[openIndex]?.timestamp_ms;
    const endTimestamp = samples[endIndex]?.timestamp_ms;
    const durationMs = finite(startTimestamp) && finite(endTimestamp) ? endTimestamp - startTimestamp : 0;
    if (durationMs >= minimumDurationMs) events.push(buildEvent(openIndex, endIndex, durationMs));
    openIndex = null;
  };
  for (let index = 0; index < samples.length; index += 1) {
    if (condition(samples[index], index)) {
      if (openIndex === null) openIndex = index;
    } else {
      close(index - 1);
    }
  }
  close(samples.length - 1);
  return events;
}

function analyzeAbnormalEvents(samples, profile, referenceLabel) {
  const rules = profile?.abnormal_events;
  const maximumEvidence = rules?.maximum_evidence_events ?? 20;
  const allEvents = [];
  const stop = rules.vehicle_stop;
  allEvents.push(...contiguousEvents(
    samples,
    (sample) => finite(sample?.speed_kph) && sample.speed_kph <= stop.maximum_speed_kph,
    stop.minimum_duration_ms,
    (startIndex, endIndex, durationMs) => {
      const expected = (referenceLabel === 'out_lap' && endIndex <= samples.length * 0.3)
        || (referenceLabel === 'in_lap' && startIndex >= samples.length * 0.7);
      return { type: 'vehicle_stop', severity: expected ? 'info' : 'warning', requires_review: !expected, context_expected: expected, start_index: startIndex, end_index: endIndex, duration_ms: durationMs };
    }
  ));

  const lock = rules.wheel_lock_candidate;
  const wheelChannels = ['wheel_speed_fl_kph', 'wheel_speed_fr_kph', 'wheel_speed_rl_kph', 'wheel_speed_rr_kph'];
  allEvents.push(...contiguousEvents(
    samples,
    (sample) => finite(sample?.speed_kph) && sample.speed_kph >= lock.minimum_vehicle_speed_kph
      && wheelChannels.filter((channel) => finite(sample?.[channel]) && sample.speed_kph - sample[channel] >= lock.minimum_wheel_deficit_kph).length >= lock.minimum_affected_wheels,
    lock.minimum_duration_ms,
    (startIndex, endIndex, durationMs) => ({ type: 'wheel_lock_candidate', severity: 'warning', requires_review: true, context_expected: false, start_index: startIndex, end_index: endIndex, duration_ms: durationMs })
  ));

  const wheelspin = rules.wheelspin_candidate;
  allEvents.push(...contiguousEvents(
    samples,
    (sample) => {
      if (!finite(sample?.speed_kph) || sample.speed_kph < wheelspin.minimum_vehicle_speed_kph) return false;
      const rear = [sample?.wheel_speed_rl_kph, sample?.wheel_speed_rr_kph].filter(finite);
      return rear.length === 2 && mean(rear) - sample.speed_kph >= wheelspin.minimum_rear_surplus_kph;
    },
    wheelspin.minimum_duration_ms,
    (startIndex, endIndex, durationMs) => ({ type: 'wheelspin_candidate', severity: 'warning', requires_review: true, context_expected: false, start_index: startIndex, end_index: endIndex, duration_ms: durationMs })
  ));

  const excursion = rules.course_excursion;
  allEvents.push(...contiguousEvents(
    samples,
    (sample) => finite(sample?.gps_latitude_deg) && finite(sample?.gps_longitude_deg)
      && (sample.gps_latitude_deg < excursion.latitude_deg[0] || sample.gps_latitude_deg > excursion.latitude_deg[1]
        || sample.gps_longitude_deg < excursion.longitude_deg[0] || sample.gps_longitude_deg > excursion.longitude_deg[1]),
    excursion.minimum_duration_ms,
    (startIndex, endIndex, durationMs) => ({ type: 'course_excursion', severity: 'warning', requires_review: true, context_expected: false, start_index: startIndex, end_index: endIndex, duration_ms: durationMs })
  ));

  const countsByType = allEvents.reduce((counts, event) => ({ ...counts, [event.type]: (counts[event.type] ?? 0) + 1 }), {});
  const reviewCount = allEvents.filter((event) => event.requires_review).length;
  const evidence = [];
  for (const event of allEvents) boundedPush(evidence, event, maximumEvidence);
  return {
    passed: reviewCount === 0,
    event_count: allEvents.length,
    review_event_count: reviewCount,
    counts_by_type: countsByType,
    events: evidence,
    evidence_truncated: allEvents.length > evidence.length,
    taxonomy: ['vehicle_stop', 'wheel_lock_candidate', 'wheelspin_candidate', 'course_excursion']
  };
}

export function analyzeLapContext(samples, profile, provenance = {}) {
  const contextApplicable = Boolean(provenance?.lap_sequence && profile?.scope?.track_names?.includes(provenance?.track));
  const classification = scoreClassification(samples.length ? featureSummary(samples, profile.classification) : {}, profile.classification);
  classification.context_applicable = contextApplicable;
  classification.passed = !contextApplicable || (classification.confidence >= profile.classification.minimum_confidence && classification.score_margin >= profile.classification.minimum_score_margin);
  classification.minimum_confidence = profile.classification.minimum_confidence;
  classification.minimum_score_margin = profile.classification.minimum_score_margin;

  const referenceLabel = provenance?.lap_sequence?.reference_label ?? null;
  const reference = {
    available: contextApplicable && referenceLabel && referenceLabel !== 'unknown',
    label: referenceLabel,
    origin: provenance?.lap_sequence?.reference_label_origin ?? null,
    agrees: null
  };
  if (reference.available) reference.agrees = classification.label === reference.label;

  return {
    profile_id: profile?.profile_id ?? 'unconfigured',
    profile_version: profile?.profile_version ?? null,
    segmentation: analyzeSegmentation(samples, profile, provenance),
    classification,
    reference,
    abnormal_events: analyzeAbnormalEvents(samples, profile, referenceLabel)
  };
}
