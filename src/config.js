import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const auditPath = resolve(process.env.AUDIT_LOG_PATH ?? './audit/events.jsonl');
export const policyPath = resolve(process.env.TELEMETRY_POLICY_PATH ?? './config/policy.json');

export async function loadPolicy() {
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const loaded = { ...policy };
  if (policy.sensor_quality_profile_path) {
    const profilePath = resolve(dirname(policyPath), policy.sensor_quality_profile_path);
    loaded.sensor_quality_profile = JSON.parse(await readFile(profilePath, 'utf8'));
  }
  if (policy.lap_context_profile_path) {
    const profilePath = resolve(dirname(policyPath), policy.lap_context_profile_path);
    loaded.lap_context_profile = JSON.parse(await readFile(profilePath, 'utf8'));
  }
  return loaded;
}
