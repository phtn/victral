import * as Schema from 'effect/Schema';
import { EvaluationRecord } from './evaluation-schema.js';
import { checkedWire } from './providers/wire.js';

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const metadata = Schema.Record(Schema.String, Schema.Unknown);
export const MessageRecord = Schema.StructWithRest(Schema.Struct({
  i: Index, kind: Schema.Literals(['user', 'talk', 'tool', 'echo', 'work', 'note']), text: Schema.String,
  size: Schema.optional(Schema.Finite), date: Schema.optional(Schema.String),
}), [metadata]);
export type MessageRecord = typeof MessageRecord.Type;
export const TreeRecord = Schema.StructWithRest(Schema.Struct({ l: Index, i: Index, text: Schema.String,
  size: Schema.optional(Schema.Finite),
}), [metadata]);
export type TreeRecord = typeof TreeRecord.Type & { size: number };
const Pair = Schema.Tuple([Index.check(Schema.isLessThanOrEqualTo(52)), Index]);
export const View = Schema.Array(Pair);
export const CompactionView = Schema.StructWithRest(Schema.Struct({ parts: View, shrinking: Schema.Boolean }), [metadata]);
// Storage checks the plan envelope; TaskPlans validates semantic limits and
// revisions for the requested project. Do not normalize persisted plan strings.
export const PlanRecord = Schema.StructWithRest(Schema.Struct({ project: Schema.String, title: Schema.String,
  steps: Schema.Array(Schema.Struct({ step: Schema.String, status: Schema.String })),
  revision: Index, updated_at: Schema.String,
}), [metadata]);
export const UsageRecord = Schema.StructWithRest(Schema.Struct({
  date: Schema.optional(Schema.String), purpose: Schema.optional(Schema.String), model: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String), latency_ms: Schema.optional(Schema.Finite), ttft_ms: Schema.optional(Schema.Finite),
  usage: Schema.optional(Schema.NullOr(metadata)),
}), [metadata]);
export const MetricsRecord = Schema.StructWithRest(Schema.Struct({
  date: Schema.optional(Schema.String), type: Schema.optional(Schema.String), generated: Schema.optional(Schema.Boolean),
  tool_calls: Schema.optional(Schema.Finite), retrievals: Schema.optional(Schema.Finite),
}), [metadata]);
export const StreamSchemas = { main: MessageRecord, tree: TreeRecord, plans: PlanRecord,
  usage: UsageRecord, metrics: MetricsRecord, evaluations: EvaluationRecord };
export type StorageStream = keyof typeof StreamSchemas;
export type StreamRecord<S extends StorageStream> = (typeof StreamSchemas)[S]['Type'];
export const checkStream = <S extends StorageStream>(stream: S, input: unknown): StreamRecord<S> =>
  checkedWire(StreamSchemas[stream], input);
export const ViewSchemas = { view: View, 'view-batch': Schema.Boolean, 'compaction-view': CompactionView };
export type ViewName = keyof typeof ViewSchemas;
export type ViewState<N extends ViewName> = (typeof ViewSchemas)[N]['Type'];
export const checkView = <N extends ViewName>(name: N, input: unknown): ViewState<N> => checkedWire(ViewSchemas[name], input);
