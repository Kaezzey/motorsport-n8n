import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadPolicy } from './config.js';
import { storeFileValidationReport } from './file-report-store.js';
import { validateTelemetry } from './validator.js';
import { ingestWorkbenchCollection } from './workbench-ingest.js';

function parseArguments(arguments_) {
  const parsed = { folder: null, output: null, purpose: 'driver_coaching', limit: undefined };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--output') parsed.output = arguments_[++index];
    else if (argument === '--purpose') parsed.purpose = arguments_[++index];
    else if (argument === '--limit') parsed.limit = Number(arguments_[++index]);
    else if (!parsed.folder) parsed.folder = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!parsed.folder) throw new Error('A Workbench manifest collection folder is required');
  if (arguments_.includes('--output') && !parsed.output) throw new Error('--output requires a file path');
  if (parsed.limit !== undefined && (!Number.isInteger(parsed.limit) || parsed.limit < 1)) throw new Error('--limit must be a positive integer');
  return parsed;
}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  const policy = await loadPolicy();
  const report = await ingestWorkbenchCollection(arguments_.folder, {
    purpose: arguments_.purpose,
    limit: arguments_.limit,
    fileValidationPolicy: policy.file_validation,
    onFileReport: storeFileValidationReport,
    submitLap: async (payload) => validateTelemetry(payload, policy)
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (arguments_.output) {
    const outputPath = resolve(arguments_.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      policy_id: policy.policy_id,
      sensor_profile_id: policy.sensor_quality_profile?.profile_id,
      lap_context_profile_id: policy.lap_context_profile?.profile_id,
      counts: report.counts
    }, null, 2));
  } else {
    console.log(serialized.trimEnd());
  }
  if (report.counts.reject > 0 || report.counts.ingestion_error > 0) process.exitCode = 1;
} catch (error) {
  console.error(`Evaluation failed: ${error.message}`);
  console.error('Usage: npm run evaluate -- <collection-folder> [--output report.json] [--purpose PURPOSE] [--limit N]');
  process.exitCode = 2;
}
