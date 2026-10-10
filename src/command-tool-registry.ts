import type { CommandTools } from './command-tools.js';
import { runCommandSchema, shellSchema, StartCommandSchema, CommandStatusSchema, StopCommandSchema, ListCommandsSchema, WriteCommandInputSchema } from './command-tool-schema.js';
import { schemaTool } from './tool-registry.js';

export function commandTools(commands: Pick<CommandTools, 'run' | 'start' | 'status' | 'stop' | 'list' | 'write'>, timeoutMs: number) {
  return [
    schemaTool({ name: 'run_command', schema: runCommandSchema(timeoutMs), capabilities: ['shell'],
      execute: (args, signal) => commands.run([args.program, ...args.args], args.timeout_ms, signal),
    }),
    schemaTool({ name: 'shell', schema: shellSchema(timeoutMs), capabilities: ['shell'],
      execute: (args, signal) => commands.run([process.env.SHELL ?? '/bin/sh', '-c', args.command], args.timeout_ms, signal),
    }),
    schemaTool({ name: 'start_command', schema: StartCommandSchema, capabilities: ['shell'],
      execute: (args, signal) => commands.start([args.program, ...args.args], args.timeout_ms, signal, args.interactive),
    }),
    schemaTool({ name: 'command_status', schema: CommandStatusSchema, capabilities: ['read', 'shell'],
      execute: (args, signal) => commands.status(args.command_id, args.wait_ms, signal),
    }),
    schemaTool({ name: 'stop_command', schema: StopCommandSchema, capabilities: ['shell'], execute: args => commands.stop(args.command_id) }),
    schemaTool({ name: 'list_commands', schema: ListCommandsSchema, capabilities: ['read', 'shell'], execute: () => commands.list() }),
    schemaTool({ name: 'write_command_input', schema: WriteCommandInputSchema, capabilities: ['shell'],
      execute: (args, signal) => commands.write(args.command_id, args.input, args.eof, signal),
    }),
  ];
}
