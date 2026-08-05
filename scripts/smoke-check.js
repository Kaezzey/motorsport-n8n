import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const port = 32000 + Math.floor(Math.random() * 1000);
const directory = await mkdtemp(join(tmpdir(), 'telemetry-agent-smoke-'));
const auditLog = join(directory, 'events.jsonl');
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), AUDIT_LOG_PATH: auditLog },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy. ${stderr}`);
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

try {
  await waitForHealth();
  const clean = JSON.parse(await readFile('samples/clean-push-lap.json', 'utf8'));
  const corrupt = JSON.parse(await readFile('samples/corrupted-lap.json', 'utf8'));
  const accepted = await post('/validate', clean);
  const rejected = await post('/validate', corrupt);
  const override = await post('/override', {
    run_id: rejected.body.run_id,
    decision: 'accept',
    reviewer: 'smoke-test-engineer',
    reason: 'Known bench sensor substitution; approved for pipeline testing only.'
  });
  const auditResponse = await fetch(`${baseUrl}/audit`);
  const audit = await auditResponse.json();

  if (accepted.body.decision !== 'accept') throw new Error('Clean telemetry was not accepted');
  if (rejected.body.decision !== 'reject') throw new Error('Corrupted telemetry was not rejected');
  if (override.status !== 201) throw new Error('Human override was not recorded');
  if (!audit.verification.valid || audit.verification.event_count !== 3) throw new Error('Audit chain verification failed');

  console.log(JSON.stringify({
    status: 'passed',
    clean_decision: accepted.body.decision,
    corrupt_decision: rejected.body.decision,
    override_recorded: true,
    audit_events: audit.verification.event_count,
    audit_chain_valid: audit.verification.valid
  }, null, 2));
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
