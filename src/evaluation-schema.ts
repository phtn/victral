import * as Schema from 'effect/Schema';
import { AuditResult } from './jev.js';

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const EvaluationRecord = Schema.Struct({
  key: Schema.String, l: Index, i: Index,
  context_parts: Schema.optional(Schema.Array(Schema.Struct({ l: Index, i: Index }))),
  requested_model: Schema.optional(Schema.String),
  status: Schema.Literals(['queued', 'running', 'skipped', 'completed', 'error']),
  date: Schema.optional(Schema.String), state_bytes: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String), error: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String), answers: Schema.optional(AuditResult.fields.answers),
  usage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)), latency_ms: Schema.optional(Schema.Number), retries: Schema.optional(Index),
});
export type EvaluationRecord = typeof EvaluationRecord.Type;
