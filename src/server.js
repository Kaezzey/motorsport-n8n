import { createServer } from 'node:http';
import { appendAuditEvent, listAuditEvents, verifyAuditLog } from './audit-log.js';
import { auditPath, loadPolicy } from './config.js';
import { validateTelemetry } from './validator.js';

const port = Number(process.env.PORT ?? 3100);
const maximumBodyBytes = 10 * 1024 * 1024;
const policy = await loadPolicy();

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'http://localhost:5678',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  response.end(JSON.stringify(body, null, 2));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBodyBytes) {
      const error = new Error('Payload exceeds 10 MiB prototype limit');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.status = 400;
    throw error;
  }
}

async function handleValidation(request, response) {
  const payload = await readJson(request);
  const result = validateTelemetry(payload, policy);
  await appendAuditEvent(auditPath, {
    occurred_at: new Date().toISOString(),
    event_type: 'telemetry_evaluated',
    run_id: result.run_id,
    actor: 'telemetry-quality-agent',
    details: result
  });
  send(response, 200, result);
}

async function handleOverride(request, response) {
  const body = await readJson(request);
  const allowedDecisions = ['accept', 'reject'];
  if (!body.run_id || !allowedDecisions.includes(body.decision) || !body.reviewer || !body.reason) {
    return send(response, 400, { error: 'run_id, reviewer, reason, and decision (accept or reject) are required' });
  }

  const events = await listAuditEvents(auditPath);
  const original = events.find((event) => event.event_type === 'telemetry_evaluated' && event.run_id === body.run_id);
  if (!original) return send(response, 404, { error: `No evaluated run found for ${body.run_id}` });

  const event = await appendAuditEvent(auditPath, {
    occurred_at: new Date().toISOString(),
    event_type: 'human_override_recorded',
    run_id: body.run_id,
    actor: body.reviewer,
    details: {
      original_decision: original.details.decision,
      override_decision: body.decision,
      reason: body.reason
    }
  });
  send(response, 201, { status: 'recorded', override: event });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return send(response, 204, {});
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, {
        status: 'ok',
        policy_id: policy.policy_id,
        sensor_profile_id: policy.sensor_quality_profile?.profile_id ?? null,
        audit_log: auditPath
      });
    }
    if (request.method === 'POST' && url.pathname === '/validate') return await handleValidation(request, response);
    if (request.method === 'POST' && url.pathname === '/override') return await handleOverride(request, response);
    if (request.method === 'GET' && url.pathname === '/audit') {
      const events = await listAuditEvents(auditPath);
      const verification = await verifyAuditLog(auditPath);
      return send(response, 200, { verification, events });
    }
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return send(response, error.status ?? 500, { error: error.status ? error.message : 'Internal server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Telemetry quality agent listening on http://127.0.0.1:${port}`);
  console.log(`Policy: ${policy.policy_id}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
