import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = JSON.parse(await readFile(new URL('../workflows/telemetry-quality-agent.json', import.meta.url), 'utf8'));

test('n8n workflow retains complete execution data', () => {
  assert.equal(workflow.settings.saveDataSuccessExecution, 'all');
  assert.equal(workflow.settings.saveDataErrorExecution, 'all');
  assert.equal(workflow.settings.saveExecutionProgress, true);
});

test('only the accept output can reach the downstream placeholder', () => {
  const acceptanceBranches = workflow.connections['Accepted by policy?'].main;
  assert.equal(acceptanceBranches[0][0].node, 'AUTHORIZED - downstream placeholder');
  assert.equal(acceptanceBranches[1][0].node, 'Human review required?');
  assert.equal(workflow.connections['Human review required?'].main[0][0].node, 'Review queue response');
  assert.equal(workflow.connections['Human review required?'].main[1][0].node, 'Reject response');
});
