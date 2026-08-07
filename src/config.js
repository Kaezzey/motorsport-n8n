import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const auditPath = resolve(process.env.AUDIT_LOG_PATH ?? './audit/events.jsonl');
export const policyPath = resolve(process.env.TELEMETRY_POLICY_PATH ?? './config/policy.json');

export async function loadPolicy() {
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  if (!policy.sensor_quality_profile_path) return policy;
  const profilePath = resolve(dirname(policyPath), policy.sensor_quality_profile_path);
  return { ...policy, sensor_quality_profile: JSON.parse(await readFile(profilePath, 'utf8')) };
}
