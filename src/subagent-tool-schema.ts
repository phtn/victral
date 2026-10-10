import * as Schema from 'effect/Schema';
import { validationDecoder } from './core/schema.js';
import { ArgumentsObjectSchema, textArgument } from './tool-argument-schema.js';

const nameMessage = 'name must be a simple identifier of at most 40 characters.';
const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/, { message: nameMessage }))
  .annotate({ identifier: nameMessage }).annotateKey({ messageMissingKey: nameMessage });
const taskMessage = 'task must contain between 1 and 12000 characters.';
// Apply bounds to raw UTF-16 text. Validate nonblank text without trimming the
// task passed to the worker or adding restrictions on literal NUL/Unicode.
const Task = Schema.String.check(Schema.isMaxLength(12_000, { message: taskMessage }),
  Schema.makeFilter(value => !!value.trim(), { message: taskMessage }))
  .annotate({ identifier: taskMessage }).annotateKey({ messageMissingKey: taskMessage });
export const SpawnSubagentSchema = Schema.Struct({ name: Name, task: Task });
export const ListSubagentsSchema = ArgumentsObjectSchema;
export const SubagentStatusSchema = Schema.Struct({ subagent_id: textArgument('subagent_id', 'Unknown subagent_id; use list_subagents.') });
export const StopSubagentSchema = SubagentStatusSchema;
export type SpawnSubagentArgs = typeof SpawnSubagentSchema.Type;

export const parseSpawnSubagent = validationDecoder(SpawnSubagentSchema, 'spawn_subagent arguments');
export const parseSubagentStatus = validationDecoder(SubagentStatusSchema, 'subagent_status arguments');
export const parseStopSubagent = validationDecoder(StopSubagentSchema, 'stop_subagent arguments');
