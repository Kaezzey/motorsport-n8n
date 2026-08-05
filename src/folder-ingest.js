import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { sha256 } from './validator.js';

export const defaultManifestNames = ['manifest.json', 'pre-cleaned-manifest.json'];

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Manifest must be a JSON object');
  if (manifest.manifest_version !== '1.0') throw new Error('manifest_version must be "1.0"');
  requireString(manifest.session_id, 'session_id');
  if (manifest.pre_cleaned !== true) throw new Error('pre_cleaned must be true for this ingestion contract');
  if (!Array.isArray(manifest.laps) || manifest.laps.length === 0) throw new Error('laps must contain at least one entry');

  const seenLapIds = new Set();
  manifest.laps.forEach((lap, index) => {
    requireString(lap?.lap_id, `laps[${index}].lap_id`);
    requireString(lap?.file, `laps[${index}].file`);
    if (isAbsolute(lap.file)) throw new Error(`laps[${index}].file must be relative to the manifest folder`);
    if (seenLapIds.has(lap.lap_id)) throw new Error(`Duplicate lap_id: ${lap.lap_id}`);
    seenLapIds.add(lap.lap_id);
    if (lap.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(lap.sha256)) throw new Error(`laps[${index}].sha256 must be a 64-character hex digest`);
  });
  return manifest;
}

async function locateManifest(folderPath, requestedName) {
  const root = await realpath(resolve(folderPath));
  const candidates = requestedName ? [requestedName] : defaultManifestNames;
  let lastError;
  for (const name of candidates) {
    if (isAbsolute(name) || dirname(name) !== '.') throw new Error('Manifest name must be a filename inside the session folder');
    const candidate = resolve(root, name);
    try {
      const resolvedManifest = await realpath(candidate);
      if (!isWithin(root, resolvedManifest)) throw new Error('Manifest resolves outside the session folder');
      return { root, path: resolvedManifest };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      lastError = error;
    }
  }
  throw new Error(`No manifest found in ${root}. Expected ${candidates.join(' or ')}`, { cause: lastError });
}

function hydrateLap(manifest, entry, rawLap) {
  const rawEnvelope = Array.isArray(rawLap) ? {} : rawLap;
  const samples = Array.isArray(rawLap) ? rawLap : rawLap?.samples;
  return {
    ...(manifest.defaults ?? {}),
    ...(rawEnvelope ?? {}),
    ...(entry.overrides ?? {}),
    session_id: manifest.session_id,
    lap_id: entry.lap_id,
    samples
  };
}

async function readLap(root, entry) {
  const candidate = resolve(root, entry.file);
  if (!isWithin(root, candidate)) throw new Error(`Path escapes the session folder: ${entry.file}`);
  const resolvedPath = await realpath(candidate);
  if (!isWithin(root, resolvedPath)) throw new Error(`Resolved path escapes the session folder: ${entry.file}`);
  const content = await readFile(resolvedPath, 'utf8');
  const contentSha256 = sha256(content);
  if (entry.sha256 && contentSha256 !== entry.sha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${entry.file}`);
  }
  let rawLap;
  try {
    rawLap = JSON.parse(content);
  } catch {
    throw new Error(`Lap file is not valid JSON: ${entry.file}`);
  }
  return { rawLap, contentSha256 };
}

export async function ingestFolder(folderPath, options) {
  if (typeof options?.submitLap !== 'function') throw new Error('submitLap function is required');
  const located = await locateManifest(folderPath, options.manifestName);
  const manifest = validateManifest(JSON.parse(await readFile(located.path, 'utf8')));
  const results = [];

  for (const entry of manifest.laps) {
    try {
      const { rawLap, contentSha256 } = await readLap(located.root, entry);
      const decision = await options.submitLap(hydrateLap(manifest, entry, rawLap), {
        manifest_path: basename(located.path),
        source_file: entry.file,
        source_sha256: contentSha256
      });
      results.push({
        lap_id: entry.lap_id,
        source_file: entry.file,
        source_sha256: contentSha256,
        status: decision.decision,
        run_id: decision.run_id ?? null,
        response: decision
      });
    } catch (error) {
      results.push({
        lap_id: entry.lap_id,
        source_file: entry.file,
        status: 'ingestion_error',
        error: error.message
      });
    }
  }

  const counts = results.reduce((totals, result) => {
    totals[result.status] = (totals[result.status] ?? 0) + 1;
    return totals;
  }, { accept: 0, review: 0, reject: 0, ingestion_error: 0 });

  return {
    manifest_version: manifest.manifest_version,
    session_id: manifest.session_id,
    manifest_path: located.path,
    pre_cleaned: true,
    processed_at: new Date().toISOString(),
    counts,
    results
  };
}
