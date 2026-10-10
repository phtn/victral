import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { AgentTools, Message, ModelPort } from '../types.js';
import { fromAbortablePromise } from './async.js';
import { IOError, ToolExecutionError } from './errors.js';

function modelEffects(model: ModelPort) {
  return {
    model: model.model,
    stream: Effect.fn('LegacyPorts.model.stream')((messages: Message[], options: Omit<Parameters<ModelPort['stream']>[1], 'signal'>) =>
      fromAbortablePromise(signal => model.stream(messages, { ...options, signal }),
        cause => new IOError({ operation: 'Model request', cause }))),
  };
}
function toolEffects(tools: AgentTools) {
  return {
    definitions: tools.definitions,
    execute: Effect.fn('LegacyPorts.tools.execute')((name: string, args: Record<string, unknown>, onNestedCall?: (name: string) => void) =>
      fromAbortablePromise(signal => tools.execute(name, args, signal, onNestedCall),
        cause => new ToolExecutionError({ tool: name, cause }))),
  };
}

// The legacy Session still owns close(), subscriptions and background jobs.
// Supplying this layer does not transfer ownership of either port.
export class LegacyPorts extends Context.Service<LegacyPorts, {
  readonly model: ReturnType<typeof modelEffects>;
  readonly tools: ReturnType<typeof toolEffects>;
}>()('victral/core/LegacyPorts') {
  static layer(model: ModelPort, tools: AgentTools): Layer.Layer<LegacyPorts> {
    return Layer.succeed(LegacyPorts, LegacyPorts.of({ model: modelEffects(model), tools: toolEffects(tools) }));
  }
}
