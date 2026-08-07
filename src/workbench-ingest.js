import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseCsvLine, validateRunCsv } from './file-validation.js';

export { parseCsvLine } from './file-validation.js';

const workbenchKind = 'motorsport-ml/run-manifest';
const workbenchVersion = '1.1';

export const channelMap = {
  timestamp_ms: 'Time (ms)',
  speed_kph: 'ecu_speed (kph)',
  throttle_pct: 'ecu_aps (%)',
  brake_pressure_bar: 'log_pbrake_f (bar)',
  steering_deg: 'log_asteer (deg)',
  rpm: 'ecu_nmot (rpm)',
  gear: 'log_dash_gear (-)',
  longitudinal_g: 'log_acc_x (g)',
  lateral_g: 'log_acc_y (g)',
  yaw_rate_deg_s: '*yaw (deg/s)',
  wheel_speed_fl_kph: 'ecu_speed_fl (kph)',
  wheel_speed_fr_kph: 'ecu_speed_fr (kph)',
  wheel_speed_rl_kph: 'ecu_speed_rl (kph)',
  wheel_speed_rr_kph: 'ecu_speed_rr (kph)',
  gps_course_deg: 'log_gps_course (deg)',
  gps_latitude_deg: 'log_gps_lat (deg)',
  gps_longitude_deg: 'log_gps_lon (deg)'
};

export const lapNumberColumn = 'PDS Lap Number (-)';

export const canonicalUnits = {
  timestamp_ms: 'ms',
  speed_kph: 'km/h',
  throttle_pct: '%',
  brake_pressure_bar: 'bar',
  steering_deg: 'deg',
  rpm: 'rpm',
  gear: 'index',
  longitudinal_g: 'g',
  lateral_g: 'g',
  yaw_rate_deg_s: 'deg/s',
  wheel_speed_kph: 'km/h',
  gps_course_deg: 'deg',
  gps_latitude_deg: 'deg',
  gps_longitude_deg: 'deg'
};

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function numberOrNull(value) {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildColumnIndices(headers) {
  const requiredSourceColumns = [...Object.values(channelMap), lapNumberColumn];
  const missing = requiredSourceColumns.filter((column) => !headers.includes(column));
  if (missing.length) throw new Error(`Run CSV is missing required columns: ${missing.join(', ')}`);
  return Object.fromEntries(headers.map((header, index) => [header, index]));
}

function mapSample(fields, indices) {
  return Object.fromEntries(Object.entries(channelMap).map(([canonical, source]) => [canonical, numberOrNull(fields[indices[source]])]));
}

async function* readLapsFromRunCsv(path) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let indices;
  let activeLapNumber = null;
  let samples = [];

  for await (const line of lines) {
    if (!indices) {
      indices = buildColumnIndices(parseCsvLine(line));
      continue;
    }
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const lapNumber = fields[indices[lapNumberColumn]]?.trim();
    if (!lapNumber) continue;
    if (activeLapNumber !== null && lapNumber !== activeLapNumber) {
      const firstTimestamp = samples[0]?.timestamp_ms ?? 0;
      yield { lapNumber: activeLapNumber, samples: samples.map((sample) => ({ ...sample, timestamp_ms: sample.timestamp_ms === null ? null : sample.timestamp_ms - firstTimestamp })) };
      samples = [];
    }
    activeLapNumber = lapNumber;
    samples.push(mapSample(fields, indices));
  }

  if (activeLapNumber !== null && samples.length) {
    const firstTimestamp = samples[0]?.timestamp_ms ?? 0;
    yield { lapNumber: activeLapNumber, samples: samples.map((sample) => ({ ...sample, timestamp_ms: sample.timestamp_ms === null ? null : sample.timestamp_ms - firstTimestamp })) };
  }
}

async function findEventFolders(collectionPath) {
  const root = await realpath(resolve(collectionPath));
  try {
    const ownManifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
    if (ownManifest.kind === workbenchKind) return [{ folder: root, manifest: ownManifest }];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const entries = await readdir(root, { withFileTypes: true });
  const events = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = await realpath(resolve(root, entry.name));
    if (!isWithin(root, folder)) continue;
    try {
      const manifest = JSON.parse(await readFile(resolve(folder, 'manifest.json'), 'utf8'));
      if (manifest.kind === workbenchKind) events.push({ folder, manifest });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!events.length) throw new Error(`No ${workbenchKind} manifests found in ${root} or its immediate subfolders`);
  return events;
}

function validateWorkbenchManifest(manifest, folder) {
  if (manifest.kind !== workbenchKind) throw new Error(`Unsupported manifest kind in ${folder}: ${manifest.kind ?? 'missing'}`);
  if (manifest.manifest_version !== workbenchVersion) throw new Error(`Unsupported manifest version in ${folder}: ${manifest.manifest_version ?? 'missing'}`);
  if (!Array.isArray(manifest.runs)) throw new Error(`Manifest runs must be an array in ${folder}`);
}

async function resolveRunCsv(eventFolder, run) {
  if (!run.historical_data_csv_path) throw new Error(`Run ${run.run_id} has no historical_data_csv_path`);
  const portableCandidate = resolve(eventFolder, 'runs', basename(run.historical_data_csv_path));
  const resolvedPath = await realpath(portableCandidate);
  if (!isWithin(eventFolder, resolvedPath)) throw new Error(`Run CSV resolves outside its event folder: ${run.run_id}`);
  const actualHash = await hashFile(resolvedPath);
  if (run.historical_data_csv_sha256 && actualHash !== run.historical_data_csv_sha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${basename(resolvedPath)}`);
  }
  return { path: resolvedPath, sha256: actualHash };
}

function compactFileValidation(report) {
  return {
    decision: report.decision,
    report_version: report.report_version,
    report_sha256: report.report_sha256,
    reason_codes: report.reason_codes,
    rows: report.rows,
    timestamps: report.timestamps,
    channels_with_missing_data: Object.entries(report.channels)
      .filter(([, channel]) => channel.missing_count > 0)
      .map(([channel, details]) => ({ channel, missing_count: details.missing_count, missing_ratio: details.missing_ratio, max_dropout_duration_ms: details.max_dropout_duration_ms }))
  };
}

function createPayload(manifest, run, lap, purpose, source, fileValidation) {
  return {
    schema_version: '1.0',
    session_id: `${run.event}::${run.session}`,
    lap_id: `${run.run_id}::LAP ${lap.lapNumber}`,
    purpose,
    expected_sample_rate_hz: 100,
    units: canonicalUnits,
    samples: lap.samples,
    provenance: {
      pre_cleaned: true,
      manifest_kind: manifest.kind,
      manifest_version: manifest.manifest_version,
      manifest_generated_at: manifest.generated_at,
      event: run.event,
      event_code: run.event_code,
      track: run.track,
      session: run.session,
      run_id: run.run_id,
      run_number: run.run_number,
      manifest_review_required: run.review_required,
      manifest_match_confidence: run.match_confidence,
      setup_hash: run.setup_hash,
      source_file: basename(source.path),
      source_sha256: source.sha256,
      file_validation: compactFileValidation(fileValidation)
    }
  };
}

export async function ingestWorkbenchCollection(collectionPath, options) {
  if (typeof options?.submitLap !== 'function') throw new Error('submitLap function is required');
  const events = await findEventFolders(collectionPath);
  const results = [];
  let submittedLaps = 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const purpose = options.purpose ?? 'driver_coaching';
  const fileReports = [];

  outer: for (const event of events) {
    validateWorkbenchManifest(event.manifest, event.folder);
    for (const run of event.manifest.runs) {
      if (run.include !== true) {
        results.push({ event_folder: basename(event.folder), run_id: run.run_id, status: 'skipped', reason: run.exclude_reason || 'Manifest include flag is false' });
        continue;
      }
      try {
        const source = await resolveRunCsv(event.folder, run);
        const fileValidation = await validateRunCsv(source.path, {
          channelMap,
          lapNumberColumn,
          canonicalUnits,
          expectedSampleRateHz: 100,
          policy: options.fileValidationPolicy,
          sourceSha256: source.sha256
        });
        if (options.onFileReport) await options.onFileReport(fileValidation);
        fileReports.push({ event_folder: basename(event.folder), run_id: run.run_id, file: fileValidation.file.name, decision: fileValidation.decision, report_sha256: fileValidation.report_sha256, reason_codes: fileValidation.reason_codes });
        if (fileValidation.decision === 'reject') {
          results.push({ event_folder: basename(event.folder), run_id: run.run_id, status: 'file_reject', reason_codes: fileValidation.reason_codes, file_validation_report_sha256: fileValidation.report_sha256 });
          continue;
        }
        for await (const lap of readLapsFromRunCsv(source.path)) {
          if (submittedLaps >= limit) break outer;
          const payload = createPayload(event.manifest, run, lap, purpose, source, fileValidation);
          const decision = await options.submitLap(payload, payload.provenance);
          results.push({
            event_folder: basename(event.folder),
            run_id: run.run_id,
            lap_id: payload.lap_id,
            source_file: payload.provenance.source_file,
            sample_count: payload.samples.length,
            status: decision.decision,
            run_execution_id: decision.run_id ?? null,
            response: decision
          });
          submittedLaps += 1;
        }
      } catch (error) {
        results.push({ event_folder: basename(event.folder), run_id: run.run_id, status: 'ingestion_error', error: error.message });
      }
    }
  }

  const counts = results.reduce((totals, result) => {
    totals[result.status] = (totals[result.status] ?? 0) + 1;
    return totals;
  }, { accept: 0, review: 0, reject: 0, prepared: 0, skipped: 0, file_reject: 0, ingestion_error: 0 });

  return {
    manifest_kind: workbenchKind,
    manifest_version: workbenchVersion,
    collection_path: resolve(collectionPath),
    event_folder_count: events.length,
    purpose,
    processed_at: new Date().toISOString(),
    counts,
    file_reports: fileReports,
    results
  };
}

export async function preflightWorkbenchCollection(collectionPath, options = {}) {
  const events = await findEventFolders(collectionPath);
  const files = [];
  for (const event of events) {
    validateWorkbenchManifest(event.manifest, event.folder);
    for (const run of event.manifest.runs) {
      if (run.include !== true) {
        files.push({ event_folder: basename(event.folder), run_id: run.run_id, decision: 'skipped', reason: run.exclude_reason || 'Manifest include flag is false' });
        continue;
      }
      try {
        const source = await resolveRunCsv(event.folder, run);
        const report = await validateRunCsv(source.path, {
          channelMap,
          lapNumberColumn,
          canonicalUnits,
          expectedSampleRateHz: 100,
          policy: options.fileValidationPolicy,
          sourceSha256: source.sha256
        });
        if (options.onFileReport) await options.onFileReport(report);
        files.push({ event_folder: basename(event.folder), run_id: run.run_id, ...report });
      } catch (error) {
        files.push({ event_folder: basename(event.folder), run_id: run.run_id, decision: 'reject', reason_codes: ['file.unreadable_or_hash_mismatch'], error: error.message });
      }
    }
  }
  const counts = files.reduce((totals, file) => {
    totals[file.decision] = (totals[file.decision] ?? 0) + 1;
    return totals;
  }, { accept: 0, review: 0, reject: 0, skipped: 0 });
  return {
    preflight_report_version: '1.0',
    collection_path: resolve(collectionPath),
    event_folder_count: events.length,
    generated_at: new Date().toISOString(),
    counts,
    files
  };
}
