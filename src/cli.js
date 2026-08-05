import { readFile } from 'node:fs/promises';
import { appendAuditEvent } from './audit-log.js';
import { auditPath, loadPolicy } from './config.js';
import { validateTelemetry } from './validator.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npm run validate -- <telemetry.json> [--no-audit]');
  process.exit(2);
}

try {
  const payload = JSON.parse(await readFile(inputPath, 'utf8'));
  const result = validateTelemetry(payload, await loadPolicy());
  if (!process.argv.includes('--no-audit')) {
    await appendAuditEvent(auditPath, {
      occurred_at: new Date().toISOString(),
      event_type: 'telemetry_evaluated',
      run_id: result.run_id,
      actor: 'telemetry-quality-cli',
      details: result
    });
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.decision === 'reject' ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
