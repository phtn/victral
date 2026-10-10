import type * as Schema from 'effect/Schema';
import { ToolAccessDenied } from './core/errors.js';
import { validationDecoder } from './core/schema.js';

export type ToolCapability = 'read' | 'write' | 'shell' | 'integrations' | 'subagents';
export type ToolInvocation = (signal?: AbortSignal) => Promise<string>;
export interface RegisteredTool {
  readonly name: string;
  readonly schema: Schema.ConstraintDecoder<unknown>;
  readonly capabilities: readonly ToolCapability[];
  readonly prepare: (value: unknown) => ToolInvocation;
}

// Erase the argument type only after binding the schema to its implementation.
// The implementation receives the inferred decoded type, never a cast record.
export function schemaTool<S extends Schema.ConstraintDecoder<unknown>>(options: {
  name: string; schema: S; capabilities: readonly ToolCapability[];
  execute: (args: S['Type'], signal?: AbortSignal) => string | Promise<string>;
}): RegisteredTool {
  const decode = validationDecoder(options.schema, `${options.name} arguments`);
  return { name: options.name, schema: options.schema, capabilities: options.capabilities,
    prepare(value) {
      const args = decode(value);
      return async signal => { signal?.throwIfAborted(); return options.execute(args, signal); };
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly capabilities: ReadonlySet<ToolCapability>;
  constructor(entries: readonly RegisteredTool[], capabilities: readonly ToolCapability[]) {
    this.capabilities = new Set(capabilities);
    for (const entry of entries) {
      if (this.tools.has(entry.name)) throw new Error(`Duplicate tool registration: ${entry.name}`);
      this.tools.set(entry.name, entry);
    }
  }
  has(name: string): boolean { return this.tools.has(name); }
  prepare(name: string, value: unknown): ToolInvocation {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Unknown or disabled tool: ${name}`);
    if (entry.capabilities.some(capability => !this.capabilities.has(capability))) throw new ToolAccessDenied({ tool: name });
    return entry.prepare(value);
  }
  async execute(name: string, value: unknown, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return this.prepare(name, value)(signal);
  }
}
