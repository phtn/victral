import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { auditSummary } from '../src/jev.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, summary: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help || !values.source || !values.summary) {
  console.log('Usage: bun run audit --source SOURCE.txt --summary SUMMARY.txt\nSends the two specified files to Jev for evaluation. Does not edit any memory or project file.');
  process.exit(values.help ? 0 : 1);
}
try {
  const result = await auditSummary(fs.readFileSync(values.source, 'utf8'), fs.readFileSync(values.summary, 'utf8'), { signal: AbortSignal.timeout(60_000) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
