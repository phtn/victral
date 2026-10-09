import { cutBytes } from './constants.js';
import { errorMessage } from './types.js';

export const PARALLEL_READ_TOOLS = new Set([
  'zoom', 'date', 'list_files', 'read_file', 'glob_files', 'search_files',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'fetch_url',
  'get_plan', 'command_status', 'list_commands',
]);
interface ReadCall { tool: string; arguments: Record<string, unknown> }

export async function parallelReads(value: unknown, execute: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error('calls must contain between 1 and 8 read-only tool calls.');
  const calls: ReadCall[] = value.map(call => {
    if (!call || typeof call !== 'object' || typeof call.tool !== 'string' || !PARALLEL_READ_TOOLS.has(call.tool)) throw new Error('parallel_tools accepts only supported read-only tools; writes, commands, and nested batches are excluded.');
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new Error('Each call needs an arguments object.');
    return { tool: call.tool, arguments: call.arguments };
  });
  signal?.throwIfAborted();
  const results = await Promise.all(calls.map(async (call, i) => {
    let output: string, status = 'completed';
    try { output = await execute(call.tool, call.arguments, signal); }
    catch (error) { if (signal?.aborted) throw error; status = 'error'; output = errorMessage(error); }
    const clipped = cutBytes(output, 3000);
    return `[${i + 1}/${calls.length} ${call.tool}; status: ${status}]\n${clipped}${clipped !== output ? '\n[batch result capped; call this tool separately for more output]' : ''}`;
  }));
  signal?.throwIfAborted();
  return results.join('\n\n');
}
