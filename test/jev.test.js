import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { auditSummary, AUDIT_QUESTIONS } from '../src/jev.js';

test('Jev audit uses structured source/summary state and three isolated judgments', async () => {
  let request;
  const result = await auditSummary('user: plan only', 'talk: completed', {
    apiKey: 'test-key', fetchImpl: async (url, options) => {
      request = { url, ...JSON.parse(options.body) };
      return new Response(JSON.stringify({ model: 'jev-test', answers: Object.fromEntries(Object.keys(AUDIT_QUESTIONS).map(key => [key, { type: 'noul', noul: 0.5 }])) }));
    },
  });
  assert.equal(request.model, 'jev-latest');
  assert.deepEqual(request.state, { source: 'user: plan only', summary: 'talk: completed' });
  assert.equal(Object.keys(request.questions).length, 3);
  assert.equal(result.answers.progress_inflated.noul, 0.5);
});
test('Jev rejects missing or malformed probabilities instead of accepting an audit', async () => {
  await assert.rejects(auditSummary('source', 'summary', { apiKey: 'test-key', fetchImpl: async () => new Response('{"answers":{}}') }), /Invalid Jev answer/);
});
