import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function storeFileValidationReport(report, directory = '.local/file-validation') {
  if (!/^[a-f0-9]{64}$/.test(report?.report_sha256 ?? '')) throw new Error('File validation report requires a valid report_sha256');
  const outputDirectory = resolve(directory);
  await mkdir(outputDirectory, { recursive: true });
  const path = resolve(outputDirectory, `${report.report_sha256}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
