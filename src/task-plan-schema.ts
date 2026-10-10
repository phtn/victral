import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import { ValidationError } from './core/errors.js';

const titleMessage = 'title must contain between 1 and 200 characters.';
const stepMessage = 'Each plan step needs nonempty text of at most 500 characters.';
const statusMessage = 'Plan status must be pending, in_progress, or completed.';
const revisionMessage = 'expected_revision must be a nonnegative integer.';
const stepsMessage = 'steps must contain between 1 and 50 plan steps.';

// Enforce limits on the original text before normalization, as the legacy
// boundary does. Character limits here count UTF-16 code units, not bytes.
function boundedText(maximum: number, message: string) {
  return Schema.String.check(
    Schema.isMaxLength(maximum, { message }),
    Schema.makeFilter(text => !!text.trim(), { message }),
  ).annotate({ identifier: message }).annotateKey({ messageMissingKey: message });
}
const Title = boundedText(200, titleMessage);
const StepText = boundedText(500, stepMessage);
const TrimmedTitle = Title.pipe(Schema.decodeTo(Schema.Trimmed, SchemaTransformation.trim()));
const TrimmedStepText = StepText.pipe(Schema.decodeTo(Schema.Trimmed, SchemaTransformation.trim()));

export const PlanStatusSchema = Schema.Literals(['pending', 'in_progress', 'completed'])
  .annotate({ identifier: statusMessage }).annotateKey({ messageMissingKey: statusMessage });
export const PlanStepSchema = Schema.Struct({ step: TrimmedStepText, status: PlanStatusSchema });
export type PlanStep = typeof PlanStepSchema.Type;
export const PlanStepsSchema = Schema.Array(PlanStepSchema).check(
  Schema.isBetweenLength(1, 50, { message: stepsMessage }),
  Schema.makeFilter(steps => steps.filter(step => step.status === 'in_progress').length <= 1,
    { message: 'Only one plan step may be in_progress.' }),
).pipe(Schema.mutable).annotate({ identifier: stepsMessage }).annotateKey({ messageMissingKey: stepsMessage });

// In v4, isInt checks Number.isSafeInteger, including the safe range.
const ExpectedRevision = Schema.Number.check(
  Schema.isInt({ message: revisionMessage }), Schema.isGreaterThanOrEqualTo(0, { message: revisionMessage }),
).annotate({ identifier: revisionMessage }).annotateKey({ messageMissingKey: revisionMessage });
export const UpdatePlanSchema = Schema.Struct({ expected_revision: ExpectedRevision, title: TrimmedTitle, steps: PlanStepsSchema });
export type PlanUpdate = typeof UpdatePlanSchema.Type;
// Decode only the revision first to preserve conflict-before-payload precedence.
const UpdateRevisionSchema = Schema.Struct({ expected_revision: ExpectedRevision });
const SavedRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const UpdatedAt = Schema.String.check(Schema.makeFilter(text => Number.isFinite(Date.parse(text)),
  { message: 'updated_at must be a valid date string.' }));
export const TaskPlanSchema = Schema.StructWithRest(Schema.Struct({
  project: Schema.String, title: Title, steps: PlanStepsSchema, revision: SavedRevision, updated_at: UpdatedAt,
}), [Schema.Record(Schema.String, Schema.Unknown)]);
export type TaskPlan = typeof TaskPlanSchema.Type;

// Tool payload/step extras are ignored; saved top-level metadata is explicitly
// extensible. Keep input values out of public validation messages.
const options = { onExcessProperty: 'ignore', reportInput: false } as const;
const decodeUpdateRevision = Schema.decodeUnknownResult(UpdateRevisionSchema, options);
const decodeUpdate = Schema.decodeUnknownResult(UpdatePlanSchema, options);
const decodeSaved = Schema.decodeUnknownResult(TaskPlanSchema, options);
function validated<A>(result: Result.Result<A, Schema.SchemaError>, prefix = ''): A {
  if (Result.isFailure(result)) throw new ValidationError({ boundary: 'Task plan',
    message: prefix + result.failure.message, cause: result.failure });
  return result.success;
}
export const parsePlanUpdateRevision = (value: unknown) => validated(decodeUpdateRevision(value)).expected_revision;
export const parsePlanUpdate = (value: unknown) => validated(decodeUpdate(value));
export const parseSavedTaskPlan = (value: unknown) => validated(decodeSaved(value),
  'Invalid saved task plan. Restore the plans log from backup.\n');
