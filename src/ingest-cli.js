import { ingestFolder } from './folder-ingest.js';
import { ingestWorkbenchCollection } from './workbench-ingest.js';
import { loadPolicy } from './config.js';
import { storeFileValidationReport } from './file-report-store.js';

function parseArguments(arguments_) {
  const parsed = {
    folder: null,
    manifestName: undefined,
    webhookUrl: process.env.N8N_WEBHOOK_URL ?? 'http://127.0.0.1:5678/webhook/telemetry/validate',
    purpose: 'driver_coaching',
    limit: undefined,
    dryRun: false
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--manifest') parsed.manifestName = arguments_[++index];
    else if (argument === '--webhook') parsed.webhookUrl = arguments_[++index];
    else if (argument === '--purpose') parsed.purpose = arguments_[++index];
    else if (argument === '--limit') parsed.limit = Number(arguments_[++index]);
    else if (argument === '--dry-run') parsed.dryRun = true;
    else if (!parsed.folder) parsed.folder = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!parsed.folder) throw new Error('A session folder is required');
  if (!parsed.manifestName && arguments_.includes('--manifest')) throw new Error('--manifest requires a filename');
  if (!parsed.webhookUrl) throw new Error('--webhook requires a URL');
  if (parsed.limit !== undefined && (!Number.isInteger(parsed.limit) || parsed.limit < 1)) throw new Error('--limit must be a positive integer');
  return parsed;
}

async function submitToN8n(webhookUrl, payload) {
  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new Error(`Could not reach n8n at ${webhookUrl}: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (![200, 202, 422].includes(response.status) || !body?.decision) {
    throw new Error(`n8n returned HTTP ${response.status}${body?.error ? `: ${body.error}` : ''}`);
  }
  return body;
}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  const policy = await loadPolicy();
  const submitLap = arguments_.dryRun
    ? async () => ({ decision: 'prepared', run_id: null, summary: 'Dry run: payload prepared but not submitted to n8n.' })
    : (payload) => submitToN8n(arguments_.webhookUrl, payload);
  let report;
  if (arguments_.manifestName) {
    report = await ingestFolder(arguments_.folder, { manifestName: arguments_.manifestName, submitLap });
  } else {
    try {
      report = await ingestWorkbenchCollection(arguments_.folder, {
        submitLap,
        purpose: arguments_.purpose,
        limit: arguments_.limit,
        fileValidationPolicy: policy.file_validation,
        onFileReport: storeFileValidationReport
      });
    } catch (error) {
      if (!error.message.startsWith('No motorsport-ml/run-manifest manifests found')) throw error;
      report = await ingestFolder(arguments_.folder, { submitLap });
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.counts.ingestion_error > 0) process.exitCode = 1;
} catch (error) {
  console.error(`Folder ingestion failed: ${error.message}`);
  console.error('Usage: npm run ingest -- <collection-or-session-folder> [--dry-run] [--limit N] [--purpose PURPOSE] [--manifest FILE] [--webhook URL]');
  process.exitCode = 2;
}
