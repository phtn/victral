import * as Schema from 'effect/Schema';
import { cutBytes } from './constants.js';
import { validationDecoder } from './core/schema.js';
import { ArgumentsObjectSchema } from './tool-argument-schema.js';
import type { RegisteredTool, ToolInvocation } from './tool-registry.js';
import { errorMessage } from './types.js';

const ReadToolSchema = Schema.Literals([
  'zoom', 'date', 'list_files', 'read_file', 'glob_files', 'search_files',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'fetch_url',
  'browse_url', 'read_web_page', 'find_in_page', 'get_plan', 'command_status', 'list_commands',
]).annotate({ identifier: 'parallel_tools accepts only supported read-only tools; writes, commands, and nested batches are excluded.' });
export const PARALLEL_READ_TOOLS: ReadonlySet<string> = new Set(ReadToolSchema.literals);
export const ParallelCallsSchema = Schema.Array(Schema.Struct({
  tool: ReadToolSchema,
  arguments: ArgumentsObjectSchema.annotate({ identifier: 'Each call needs an arguments object.' })
    .annotateKey({ messageMissingKey: 'Each call needs an arguments object.' }),
})).check(Schema.isBetweenLength(1, 8, { message: 'calls must contain between 1 and 8 read-only tool calls.' }));
export const ParallelToolsSchema = Schema.Struct({ calls: ParallelCallsSchema });
const decode = validationDecoder(ParallelToolsSchema, 'parallel_tools arguments');

export function parallelTools(prepare: (name: string, args: unknown) => ToolInvocation): RegisteredTool {
  return { name: 'parallel_tools', schema: ParallelToolsSchema, capabilities: ['read'], prepare(value) {
    const { calls } = decode(value);
    // Decode every nested tool before returning an invocation. Runtime failures
    // (missing files/pages, HTTP errors) remain independent per-call results.
    const invocations = calls.map(call => prepare(call.tool, call.arguments));
    return async (signal, onNestedCall) => {
      signal?.throwIfAborted();
      const results = await Promise.all(calls.map(async (call, i) => {
        let output: string, status = 'completed';
        try { onNestedCall?.(call.tool); output = await invocations[i]!(signal); }
        catch (error) { if (signal?.aborted) throw error; status = 'error'; output = errorMessage(error); }
        const clipped = cutBytes(output, 3000);
        return `[${i + 1}/${calls.length} ${call.tool}; status: ${status}]\n${clipped}${clipped !== output ? '\n[batch result capped; call this tool separately for more output]' : ''}`;
      }));
      signal?.throwIfAborted();
      return results.join('\n\n');
    };
  } };
}
