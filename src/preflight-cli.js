import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadPolicy } from './config.js';
import { storeFileValidationReport } from './file-report-store.js';
import { preflightWorkbenchCollection } from './workbench-ingest.js';

function parseArguments(arguments_) {
  const parsed = { folder: null, output: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === '--output') parsed.output = arguments_[++index];
    else if (!parsed.folder) parsed.folder = arguments_[index];
    else throw new Error(`Unexpected argument: ${arguments_[index]}`);
  }
  if (!parsed.folder) throw new Error('A Workbench manifest collection folder is required');
  if (arguments_.includes('--output') && !parsed.output) throw new Error('--output requires a file path');
  return parsed;
}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  const policy = await loadPolicy();
  const report = await preflightWorkbenchCollection(arguments_.folder, {
    fileValidationPolicy: policy.file_validation,
    onFileReport: storeFileValidationReport
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (arguments_.output) {
    const outputPath = resolve(arguments_.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
    console.log(JSON.stringify({ output: outputPath, counts: report.counts }, null, 2));
  } else {
    console.log(serialized.trimEnd());
  }
  if (report.counts.reject > 0) process.exitCode = 1;
} catch (error) {
  console.error(`Preflight failed: ${error.message}`);
  console.error('Usage: npm run preflight -- <collection-folder> [--output report.json]');
  process.exitCode = 2;
}
