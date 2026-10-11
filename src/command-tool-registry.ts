import * as Effect from 'effect/Effect';
import { toolPromise } from './tool-effects.js';
import type { CommandTools } from './command-tools.js';
import { runCommandSchema, shellSchema, StartCommandSchema, CommandStatusSchema, StopCommandSchema, ListCommandsSchema, WriteCommandInputSchema } from './command-tool-schema.js';
import { schemaTool } from './tool-registry.js';

export function commandTools(commands: Pick<CommandTools, 'run' | 'start' | 'status' | 'stop' | 'list' | 'write'> & Partial<Pick<CommandTools, 'runEffect' | 'statusEffect' | 'stopEffect' | 'writeEffect'>>, timeoutMs: number) {
  return [
    schemaTool({ name: 'run_command', schema: runCommandSchema(timeoutMs), capabilities: ['shell'],
      execute: (args, signal) => commands.run([args.program, ...args.args], args.timeout_ms, signal),
      executeEffect: (args, signal) => commands.runEffect?.([args.program, ...args.args], args.timeout_ms, signal)
        ?? toolPromise(actual => commands.run([args.program, ...args.args], args.timeout_ms, actual), signal),
    }),
    schemaTool({ name: 'shell', schema: shellSchema(timeoutMs), capabilities: ['shell'],
      execute: (args, signal) => commands.run([process.env.SHELL ?? '/bin/sh', '-c', args.command], args.timeout_ms, signal),
      executeEffect: (args, signal) => commands.runEffect?.([process.env.SHELL ?? '/bin/sh', '-c', args.command], args.timeout_ms, signal)
        ?? toolPromise(actual => commands.run([process.env.SHELL ?? '/bin/sh', '-c', args.command], args.timeout_ms, actual), signal),
    }),
    schemaTool({ name: 'start_command', schema: StartCommandSchema, capabilities: ['shell'],
      execute: (args, signal) => commands.start([args.program, ...args.args], args.timeout_ms, signal, args.interactive),
      // The caller supplies its turn lifetime explicitly; the job belongs to the
      // command session scope, not the transient invocation fiber.
      executeEffect: (args, signal) => Effect.try({ try: () => commands.start([args.program, ...args.args], args.timeout_ms, signal, args.interactive), catch: error => error }),
    }),
    schemaTool({ name: 'command_status', schema: CommandStatusSchema, capabilities: ['read', 'shell'],
      execute: (args, signal) => commands.status(args.command_id, args.wait_ms, signal),
      executeEffect: (args, signal) => commands.statusEffect?.(args.command_id, args.wait_ms, signal)
        ?? toolPromise(actual => commands.status(args.command_id, args.wait_ms, actual), signal),
    }),
    schemaTool({ name: 'stop_command', schema: StopCommandSchema, capabilities: ['shell'], execute: args => commands.stop(args.command_id),
      executeEffect: args => commands.stopEffect?.(args.command_id) ?? toolPromise(() => commands.stop(args.command_id)) }),
    schemaTool({ name: 'list_commands', schema: ListCommandsSchema, capabilities: ['read', 'shell'], execute: () => commands.list() }),
    schemaTool({ name: 'write_command_input', schema: WriteCommandInputSchema, capabilities: ['shell'],
      execute: (args, signal) => commands.write(args.command_id, args.input, args.eof, signal),
      executeEffect: (args, signal) => commands.writeEffect?.(args.command_id, args.input, args.eof, signal)
        ?? toolPromise(actual => commands.write(args.command_id, args.input, args.eof, actual), signal),
    }),
  ];
}
