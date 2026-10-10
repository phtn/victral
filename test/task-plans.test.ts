import { expect, test } from 'bun:test';
import * as Schema from 'effect/Schema';
import { TaskPlans, type TaskPlan } from '../src/task-plans.js';
import { TaskPlanSchema, UpdatePlanSchema, parsePlanUpdate, parseSavedTaskPlan } from '../src/task-plan-schema.js';
import { ValidationError } from '../src/core/errors.js';

const project = '/fixture/project';
const input = { expected_revision: 0, title: 'Check plans', steps: [{ step: 'Inspect', status: 'pending' }] };
const saved = (overrides: Record<string, unknown> = {}) => ({ project, title: 'Saved plan', steps: input.steps,
  revision: 1, updated_at: '2026-10-10T00:00:00.000Z', ...overrides });

test('plan schemas normalize updates within raw text/collection bounds and discard tool extras', () => {
  const records: TaskPlan[] = [];
  const plans = new TaskPlans(project, { load: () => [], save: plan => { records.push(plan); } });
  const title = ' 🦓' + 'x'.repeat(197); // Exactly 200 UTF-16 code units.
  const step = ' \t' + 'x'.repeat(497) + '\n'; // Exactly 500 code units.
  const steps = Array.from({ length: 50 }, (_, index) => ({ step, status: index === 0 ? 'in_progress' : 'completed', extra: true }));
  expect(title.length).toBe(200); expect(step.length).toBe(500);
  const result = JSON.parse(plans.update({ ...input, title, steps, extra: 'discarded' }));
  expect(result.title).toBe(title.trim()); expect(result.steps).toHaveLength(50);
  expect(result.steps[0]).toEqual({ step: step.trim(), status: 'in_progress' });
  expect(result.steps[49]).toEqual({ step: step.trim(), status: 'completed' });
  expect(Object.keys(result)).toEqual(['project', 'title', 'steps', 'revision', 'updated_at']);
  expect(records).toEqual([result]); expect(result.updated_at).toBe(new Date(result.updated_at).toISOString());

  const decoded = parsePlanUpdate({ ...input, title: '\tWork 🦓\n', steps: [{ step: ' Inspect \n', status: 'pending', extra: true }], extra: true });
  const encoded = Schema.encodeSync(UpdatePlanSchema)(decoded);
  expect(encoded).toEqual({ expected_revision: 0, title: 'Work 🦓', steps: [{ step: 'Inspect', status: 'pending' }] });
  expect(parsePlanUpdate(encoded)).toEqual(decoded);
});

test('plan input schemas reject malformed values without persisting or changing state', () => {
  let writes = 0;
  const plans = new TaskPlans(project, { load: () => [], save() { writes++; } });
  const before = plans.get();
  const invalid = [
    ...[undefined, null, '', ' \t\n', 42, 'x'.repeat(201), 'x' + ' '.repeat(200)].map(title => ({ ...input, title })),
    ...[undefined, null, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(expected_revision => ({ ...input, expected_revision })),
    ...[undefined, null, {}, [], Array.from({ length: 51 }, () => input.steps[0])].map(steps => ({ ...input, steps })),
    ...[null, 'text', {}, { step: undefined, status: 'pending' }, { step: '', status: 'pending' },
      { step: ' \n', status: 'pending' }, { step: 42, status: 'pending' }, { step: 'x'.repeat(501), status: 'pending' },
      { step: 'x' + ' '.repeat(500), status: 'pending' }, { step: 'Inspect' }, { step: 'Inspect', status: null },
      { step: 'Inspect', status: 'fixture-private-status' }].map(step => ({ ...input, steps: [step] })),
    { ...input, steps: [{ step: 'one', status: 'in_progress' }, { step: 'two', status: 'in_progress' }] },
  ];
  for (const args of invalid) {
    expect(() => plans.update(args)).toThrow(ValidationError);
    expect(plans.get()).toBe(before); expect(plans.context()).toBe('');
  }
  expect(writes).toBe(0);
  for (const value of [null, [], 'text', {}]) expect(() => parsePlanUpdate(value)).toThrow(ValidationError);
});

test('plan validation reports useful paths with typed causes and without input values', () => {
  const error = (() => {
    try { parsePlanUpdate({ ...input, steps: [{ step: 'Inspect', status: 'fixture-private-status' }] }); }
    catch (error) { return error; }
  })();
  expect(error).toBeInstanceOf(ValidationError);
  if (!(error instanceof ValidationError)) throw new Error('Expected a validation error.');
  expect(error.cause).toBeInstanceOf(Schema.SchemaError);
  expect(error.message).toContain('Plan status');
  expect(error.message).toContain('["steps"][0]["status"]');
  expect(error.message).not.toContain('fixture-private-status');
});

test('revision checks still precede payload validation and reject stale input without writes', () => {
  const records: TaskPlan[] = [];
  const plans = new TaskPlans(project, { load: () => [], save: plan => { records.push(plan); } });
  plans.update(input);
  const before = plans.get();
  expect(() => plans.update({ expected_revision: 'private-value', title: '', steps: [] })).toThrow('expected_revision must be a nonnegative integer');
  expect(() => plans.update({ expected_revision: 0, title: '', steps: [] })).toThrow('Plan revision changed: expected 0, current 1. Read get_plan before updating.');
  expect(plans.get()).toBe(before); expect(records).toHaveLength(1);
});

test('replacing a plan publishes only after saving and keeps the prior plan on save failure', () => {
  let fail = false;
  const records: TaskPlan[] = [], observed: string[] = [];
  const plans = new TaskPlans(project, { load: () => [], save: plan => {
    observed.push(plans.get());
    if (fail) throw new Error('disk full');
    records.push(plan);
  } });
  const empty = plans.get();
  const before = plans.update(input), context = plans.context();
  expect(observed).toEqual([empty]);
  fail = true;
  expect(() => plans.update({ ...input, expected_revision: 1, title: 'New work' })).toThrow('disk full');
  expect(plans.get()).toBe(before); expect(plans.context()).toBe(context);
  expect(observed).toEqual([empty, before]); expect(records).toHaveLength(1);
  fail = false;
  const next = JSON.parse(plans.update({ ...input, expected_revision: 1, title: 'New work' }));
  expect(next.revision).toBe(2); expect(next.title).toBe('New work'); expect(records).toHaveLength(2);
  expect(observed).toEqual([empty, before, before]);
});

test('saved-plan migration matches legacy rendering, title whitespace and extensible metadata', async () => {
  const legacy = await Bun.file(new URL('./fixtures/effect-migration/legacy-task-plans.json', import.meta.url)).json();
  const plans = new TaskPlans(legacy.project, { load: () => legacy.records, save() { throw new Error('No fixture writes.'); } });
  expect(plans.get()).toBe(legacy.get); expect(plans.context()).toBe(legacy.context);
  const latest = legacy.records.at(-1);
  const decoded = parseSavedTaskPlan(latest);
  expect(decoded.title).toBe(' Latest saved title ');
  expect(decoded.updated_at).toBe('2026-01-02');
  expect(decoded.steps[1]).toEqual({ step: 'Verify restart 🦓', status: 'in_progress' });
  expect(decoded.legacy_metadata).toEqual(latest.legacy_metadata);
  expect(decoded.legacy_flag).toBe(true);
  expect(parseSavedTaskPlan(Schema.encodeSync(TaskPlanSchema)(decoded))).toEqual(decoded);
});

test('saved-plan schemas reject corrupt owned records while skipping unrelated records', () => {
  const ignored = [null, 'text', 1, [], {}, { project: '/other', title: '', revision: 0, updated_at: null, steps: [] }];
  expect(new TaskPlans(project, { load: () => ignored, save() {} }).get()).toContain('No task plan');
  expect(JSON.parse(new TaskPlans(project, { load: () => [...ignored, saved()], save() {} }).get()).revision).toBe(1);
  const corrupt = [
    ...[undefined, null, '', ' \n', 42, 'x'.repeat(201)].map(title => saved({ title })),
    ...[undefined, null, 0, -1, 0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(revision => saved({ revision })),
    ...[undefined, null, 42, '', 'invalid-date'].map(updated_at => saved({ updated_at })),
    ...[undefined, null, [], [{ step: 'Inspect', status: 'unknown' }],
      [{ step: 'one', status: 'in_progress' }, { step: 'two', status: 'in_progress' }]].map(steps => saved({ steps })),
  ];
  for (const record of corrupt) {
    expect(() => new TaskPlans(project, { load: () => [record], save() {} })).toThrow('Invalid saved task plan. Restore the plans log from backup.');
  }
});

test('saved revisions must increase, allow gaps, and never overflow on update', () => {
  for (const revision of [1, 2]) {
    expect(() => new TaskPlans(project, { load: () => [saved({ revision: 2 }), saved({ revision })], save() {} })).toThrow('Saved task plan revisions must increase');
  }
  const gaps = new TaskPlans(project, { load: () => [saved(), saved({ revision: 7 })], save() {} });
  expect(JSON.parse(gaps.get()).revision).toBe(7);
  const records: TaskPlan[] = [];
  const plans = new TaskPlans(project, { load: () => [saved({ revision: Number.MAX_SAFE_INTEGER - 1 })], save: plan => { records.push(plan); } });
  const before = plans.update({ ...input, expected_revision: Number.MAX_SAFE_INTEGER - 1 });
  expect(JSON.parse(before).revision).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => plans.update({ ...input, expected_revision: Number.MAX_SAFE_INTEGER })).toThrow('Task plan revision cannot exceed Number.MAX_SAFE_INTEGER');
  expect(plans.get()).toBe(before); expect(records).toHaveLength(1);
  expect(JSON.parse(new TaskPlans(project, { load: () => records, save() {} }).get()).revision).toBe(Number.MAX_SAFE_INTEGER);
});
