import * as Effect from 'effect/Effect';
import { legacyToolEffect, runToolEffect, toolPromise } from './tool-effects.js';
import type * as Schema from 'effect/Schema';
import { ToolAccessDenied } from './core/errors.js';
import { validationDecoder } from './core/schema.js';

export type ToolCapability = 'read' | 'write' | 'shell' | 'integrations' | 'subagents';
export type ToolInvocation = ((signal?: AbortSignal, onNestedCall?: (name: string) => void) => Promise<string>) & {
  effect?: (signal?: AbortSignal, onNestedCall?: (name: string) => void) => Effect.Effect<string, unknown>;
};
export function invocationEffect(invoke: ToolInvocation, signal?: AbortSignal, nested?: (name: string) => void): Effect.Effect<string, unknown> {
  return invoke.effect ? invoke.effect(signal, nested) : toolPromise(actual => invoke(actual, nested), signal);
}
export function effectInvocation(effect: NonNullable<ToolInvocation['effect']>): ToolInvocation {
  return Object.assign((signal?: AbortSignal, nested?: (name: string) => void) => runToolEffect(legacyToolEffect(effect(signal, nested)), signal), { effect });
}
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
  // Synchronous, read-only domain checks that must precede full decoding.
  beforeDecode?: (value: unknown) => void;
  execute: (args: S['Type'], signal?: AbortSignal) => string | Promise<string>;
  executeEffect?: (args: S['Type'], signal?: AbortSignal) => Effect.Effect<string, unknown>;
}): RegisteredTool {
  const decode = validationDecoder(options.schema, `${options.name} arguments`);
  return { name: options.name, schema: options.schema, capabilities: options.capabilities,
    prepare(value) {
      options.beforeDecode?.(value);
      const args = decode(value);
      return effectInvocation(signal => options.executeEffect ? Effect.suspend(() => options.executeEffect!(args, signal))
        : toolPromise(actual => options.execute(args, actual), signal));
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
  executeEffect(name: string, value: unknown, onNestedCall?: (name: string) => void, origin?: AbortSignal): Effect.Effect<string, unknown> {
    return Effect.flatMap(Effect.try({ try: () => { origin?.throwIfAborted(); return this.prepare(name, value); }, catch: error => error }),
      invoke => invocationEffect(invoke, origin, onNestedCall));
  }
  async execute(name: string, value: unknown, signal?: AbortSignal, onNestedCall?: (name: string) => void): Promise<string> {
    signal?.throwIfAborted();
    return runToolEffect(legacyToolEffect(this.executeEffect(name, value, onNestedCall, signal)), signal);
  }
}
