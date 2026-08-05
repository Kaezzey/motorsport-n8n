import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const auditPath = resolve(process.env.AUDIT_LOG_PATH ?? './audit/events.jsonl');
export const policyPath = resolve(process.env.TELEMETRY_POLICY_PATH ?? './config/policy.json');

export async function loadPolicy() {
  return JSON.parse(await readFile(policyPath, 'utf8'));
}
