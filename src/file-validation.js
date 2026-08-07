import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';

export const defaultFileValidationPolicy = {
  timestamp_gap_multiplier: 5,
  maximum_malformed_row_ratio: 0,
  maximum_duplicate_timestamps: 0,
  maximum_timestamp_resets: 0,
  maximum_timestamp_missing_ratio: 0,
  sample_rate_tolerance_ratio: 0.05,
  maximum_gap_count_before_review: 0,
  maximum_channel_missing_ratio: 0.01,
  maximum_dropout_duration_ms_before_review: 50
};

const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[midpoint] : (ordered[midpoint - 1] + ordered[midpoint]) / 2;
};

export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('Unterminated quoted CSV field');
  fields.push(field.replace(/\r$/, ''));
  return fields;
}

function sourceUnit(header) {
  return header.match(/\(([^()]*)\)\s*$/)?.[1] ?? 'unspecified';
}

function canonicalUnit(canonicalUnits, channel) {
  if (channel.startsWith('wheel_speed_')) return canonicalUnits.wheel_speed_kph;
  return canonicalUnits[channel];
}

function closeDropout(channelState, endRow, endTimestamp, expectedIntervalMs) {
  if (!channelState.open_dropout) return;
  const open = channelState.open_dropout;
  const sampleCount = endRow - open.start_row + 1;
  const durationMs = Number.isFinite(open.start_timestamp) && Number.isFinite(endTimestamp)
    ? Math.max(expectedIntervalMs, endTimestamp - open.start_timestamp + expectedIntervalMs)
    : sampleCount * expectedIntervalMs;
  const interval = {
    start_row: open.start_row,
    end_row: endRow,
    start_timestamp_ms: open.start_timestamp,
    end_timestamp_ms: Number.isFinite(endTimestamp) ? endTimestamp : null,
    sample_count: sampleCount,
    duration_ms: durationMs
  };
  channelState.dropout_interval_count += 1;
  channelState.max_dropout_duration_ms = Math.max(channelState.max_dropout_duration_ms, durationMs);
  if (channelState.dropout_intervals.length < 20) channelState.dropout_intervals.push(interval);
  channelState.open_dropout = null;
}

function completeSegment(segment, endRow, endTimestamp) {
  if (!segment) return null;
  const durationMs = endTimestamp - segment.start_timestamp_ms;
  return {
    ...segment,
    end_row: endRow,
    end_timestamp_ms: endTimestamp,
    duration_ms: durationMs,
    observed_hz: durationMs > 0 && segment.sample_count > 1 ? ((segment.sample_count - 1) * 1000) / durationMs : 0
  };
}

export async function validateRunCsv(path, options) {
  const {
    channelMap,
    lapNumberColumn,
    canonicalUnits,
    expectedSampleRateHz,
    policy: configuredPolicy,
    sourceSha256,
    sourceSchema = 'motorsport-workbench-csv/1.0'
  } = options;
  const policy = { ...defaultFileValidationPolicy, ...(configuredPolicy ?? {}) };
  const expectedIntervalMs = 1000 / expectedSampleRateHz;
  const fileStats = await stat(path);
  const checks = [];
  const record = (id, severity, passed, summary, metrics = {}) => checks.push({ id, severity, passed, summary, metrics });
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let headers;
  let indices;
  let dataRows = 0;
  let emptyRows = 0;
  let malformedRows = 0;
  let assignedLapRows = 0;
  let lastTimestamp = null;
  let lastTimestampRow = null;
  let timestampMissing = 0;
  let timestampDuplicates = 0;
  let timestampResets = 0;
  let gapCount = 0;
  let maximumGapMs = 0;
  const gaps = [];
  const positiveIntervals = [];
  const segments = [];
  let activeSegment = null;
  const channelStates = Object.fromEntries(Object.keys(channelMap).map((channel) => [channel, {
    missing_count: 0,
    invalid_count: 0,
    dropout_interval_count: 0,
    max_dropout_duration_ms: 0,
    dropout_intervals: [],
    open_dropout: null
  }]));

  for await (const line of lines) {
    if (!headers) {
      headers = parseCsvLine(line);
      const requiredHeaders = [...Object.values(channelMap), lapNumberColumn];
      const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
      const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
      record('file.schema.required_columns', 'error', missingHeaders.length === 0, missingHeaders.length ? `Missing required CSV columns: ${missingHeaders.join(', ')}` : 'All required CSV columns are present', { missing_headers: missingHeaders });
      record('file.schema.duplicate_columns', 'error', duplicateHeaders.length === 0, duplicateHeaders.length ? `Duplicate CSV columns: ${[...new Set(duplicateHeaders)].join(', ')}` : 'CSV column names are unique', { duplicate_headers: [...new Set(duplicateHeaders)] });
      if (missingHeaders.length || duplicateHeaders.length) break;
      indices = Object.fromEntries(headers.map((header, index) => [header, index]));
      continue;
    }

    if (!line.trim()) {
      emptyRows += 1;
      continue;
    }
    dataRows += 1;
    const fields = parseCsvLine(line);
    if (fields.length !== headers.length) malformedRows += 1;
    if (fields[indices[lapNumberColumn]]?.trim()) assignedLapRows += 1;

    const timestampText = fields[indices[channelMap.timestamp_ms]];
    const timestamp = timestampText?.trim() === '' ? null : Number(timestampText);
    const validTimestamp = Number.isFinite(timestamp);
    if (!validTimestamp) {
      timestampMissing += 1;
    } else {
      if (!activeSegment) {
        activeSegment = { start_row: dataRows, start_timestamp_ms: timestamp, sample_count: 1, reason: segments.length ? 'timestamp_reset' : 'file_start' };
      }
      if (lastTimestamp !== null) {
        const interval = timestamp - lastTimestamp;
        if (interval === 0) timestampDuplicates += 1;
        if (interval < 0) {
          timestampResets += 1;
          const finished = completeSegment(activeSegment, lastTimestampRow, lastTimestamp);
          if (finished) segments.push(finished);
          activeSegment = { start_row: dataRows, start_timestamp_ms: timestamp, sample_count: 1, reason: 'timestamp_reset' };
        } else if (interval > 0) {
          activeSegment.sample_count += 1;
          positiveIntervals.push(interval);
          if (interval > expectedIntervalMs * policy.timestamp_gap_multiplier) {
            gapCount += 1;
            maximumGapMs = Math.max(maximumGapMs, interval);
            if (gaps.length < 20) gaps.push({ previous_row: lastTimestampRow, row: dataRows, previous_timestamp_ms: lastTimestamp, timestamp_ms: timestamp, gap_ms: interval });
          }
        } else {
          activeSegment.sample_count += 1;
        }
      }
      lastTimestamp = timestamp;
      lastTimestampRow = dataRows;
    }

    for (const [channel, sourceHeader] of Object.entries(channelMap)) {
      const state = channelStates[channel];
      const text = fields[indices[sourceHeader]];
      const missing = text === undefined || text.trim() === '';
      const numeric = missing ? null : Number(text);
      const invalid = !missing && !Number.isFinite(numeric);
      if (missing || invalid) {
        state.missing_count += 1;
        if (invalid) state.invalid_count += 1;
        if (!state.open_dropout) state.open_dropout = { start_row: dataRows, start_timestamp: validTimestamp ? timestamp : null };
      } else if (state.open_dropout) {
        closeDropout(state, dataRows - 1, lastTimestamp === timestamp ? timestamp - expectedIntervalMs : lastTimestamp, expectedIntervalMs);
      }
    }
  }

  if (!headers) record('file.schema.required_columns', 'error', false, 'CSV file is empty', { missing_headers: Object.values(channelMap) });
  if (activeSegment && lastTimestamp !== null) {
    const finished = completeSegment(activeSegment, lastTimestampRow, lastTimestamp);
    if (finished) segments.push(finished);
  }
  for (const state of Object.values(channelStates)) closeDropout(state, dataRows, lastTimestamp, expectedIntervalMs);

  const malformedRatio = dataRows ? malformedRows / dataRows : 1;
  record('file.rows.malformed', 'error', malformedRatio <= policy.maximum_malformed_row_ratio, malformedRows ? `${malformedRows} row(s) have an unexpected field count` : 'All data rows match the header width', { malformed_rows: malformedRows, malformed_ratio: malformedRatio });
  record('file.timestamps.duplicates', 'error', timestampDuplicates <= policy.maximum_duplicate_timestamps, timestampDuplicates ? `${timestampDuplicates} duplicate timestamp interval(s)` : 'No duplicate timestamps detected', { duplicate_count: timestampDuplicates });
  record('file.timestamps.resets', 'error', timestampResets <= policy.maximum_timestamp_resets, timestampResets ? `${timestampResets} timestamp reset(s) divide the file into ${segments.length} segments` : 'No timestamp resets detected', { reset_count: timestampResets, segments });

  const timestampMissingRatio = dataRows ? timestampMissing / dataRows : 1;
  record('file.timestamps.missing', 'error', timestampMissingRatio <= policy.maximum_timestamp_missing_ratio, timestampMissing ? `${timestampMissing} row(s) have missing or invalid timestamps` : 'Every data row has a numeric timestamp', { missing_count: timestampMissing, missing_ratio: timestampMissingRatio });

  const medianIntervalMs = median(positiveIntervals);
  const observedHz = medianIntervalMs ? 1000 / medianIntervalMs : 0;
  const sampleRateError = Math.abs(observedHz - expectedSampleRateHz) / expectedSampleRateHz;
  record('file.timestamps.sample_rate', 'warning', sampleRateError <= policy.sample_rate_tolerance_ratio, `Observed median sample rate ${observedHz.toFixed(3)} Hz; expected ${expectedSampleRateHz} Hz`, { expected_hz: expectedSampleRateHz, observed_hz: observedHz, median_interval_ms: medianIntervalMs, error_ratio: sampleRateError });
  record('file.timestamps.gaps', 'warning', gapCount <= policy.maximum_gap_count_before_review, gapCount ? `${gapCount} timestamp gap(s), maximum ${maximumGapMs} ms` : 'No timestamp gaps exceed the configured multiplier', { gap_count: gapCount, maximum_gap_ms: maximumGapMs, gaps });

  const channels = Object.fromEntries(Object.entries(channelStates).map(([channel, state]) => {
    const { open_dropout: ignored, ...complete } = state;
    return [channel, {
      ...complete,
      missing_ratio: dataRows ? state.missing_count / dataRows : 1,
      source_header: channelMap[channel],
      source_unit: sourceUnit(channelMap[channel]),
      canonical_unit: canonicalUnit(canonicalUnits, channel)
    }];
  }));
  const failingMissingChannels = Object.entries(channels).filter(([, channel]) => channel.missing_ratio > policy.maximum_channel_missing_ratio).map(([channel]) => channel);
  const longDropoutChannels = Object.entries(channels).filter(([, channel]) => channel.max_dropout_duration_ms > policy.maximum_dropout_duration_ms_before_review).map(([channel]) => channel);
  record('file.channels.missing', 'error', failingMissingChannels.length === 0, failingMissingChannels.length ? `Channel missingness exceeds policy: ${failingMissingChannels.join(', ')}` : 'Per-channel missingness is within policy', { failing_channels: failingMissingChannels, maximum_ratio: policy.maximum_channel_missing_ratio });
  record('file.channels.dropouts', 'warning', longDropoutChannels.length === 0, longDropoutChannels.length ? `Long dropout intervals detected: ${longDropoutChannels.join(', ')}` : 'No channel dropout exceeds the review threshold', { failing_channels: longDropoutChannels, maximum_duration_ms: policy.maximum_dropout_duration_ms_before_review });

  const hardFailureIds = new Set(['file.schema.required_columns', 'file.schema.duplicate_columns', 'file.rows.malformed', 'file.timestamps.duplicates', 'file.timestamps.resets', 'file.timestamps.missing', 'file.channels.missing']);
  const reviewIds = new Set(['file.timestamps.sample_rate', 'file.timestamps.gaps', 'file.channels.dropouts']);
  const hardFailures = checks.filter((check) => !check.passed && hardFailureIds.has(check.id));
  const reviewTriggers = checks.filter((check) => !check.passed && reviewIds.has(check.id));
  const decision = hardFailures.length ? 'reject' : reviewTriggers.length ? 'review' : 'accept';

  const report = {
    report_version: '1.0',
    source_schema: sourceSchema,
    canonical_schema: 'motorsport-telemetry-lap/1.0',
    file: { name: basename(path), size_bytes: fileStats.size, sha256: sourceSha256 ?? null },
    schema: {
      header_count: headers?.length ?? 0,
      migration: {
        from: sourceSchema,
        to: 'motorsport-telemetry-lap/1.0',
        strategy: 'declared_channel_mapping',
        lossy: false
      },
      source_to_canonical: Object.entries(channelMap).map(([canonical_channel, source_header]) => ({
        canonical_channel,
        source_header,
        source_unit: sourceUnit(source_header),
        canonical_unit: canonicalUnit(canonicalUnits, canonical_channel),
        transform: 'identity'
      }))
    },
    rows: { data_rows: dataRows, empty_rows: emptyRows, malformed_rows: malformedRows, lap_assigned_rows: assignedLapRows, unassigned_rows: dataRows - assignedLapRows },
    timestamps: {
      expected_hz: expectedSampleRateHz,
      observed_hz: observedHz,
      median_interval_ms: medianIntervalMs,
      duplicate_count: timestampDuplicates,
      reset_count: timestampResets,
      gap_count: gapCount,
      maximum_gap_ms: maximumGapMs,
      segments
    },
    channels,
    decision,
    reason_codes: [...hardFailures, ...reviewTriggers].map((check) => check.id),
    checks
  };
  return { ...report, report_sha256: createHash('sha256').update(JSON.stringify(report)).digest('hex') };
}
