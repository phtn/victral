import type { Subagents } from './subagents.js';
import { SpawnSubagentSchema, ListSubagentsSchema, SubagentStatusSchema, StopSubagentSchema } from './subagent-tool-schema.js';
import { schemaTool } from './tool-registry.js';

export function subagentTools(agents: Pick<Subagents, 'spawnTask' | 'list' | 'statusOf' | 'stopJob'>) {
  return [
    schemaTool({ name: 'spawn_subagent', schema: SpawnSubagentSchema, capabilities: ['subagents'], execute: (args, signal) => agents.spawnTask(args, signal) }),
    schemaTool({ name: 'list_subagents', schema: ListSubagentsSchema, capabilities: ['read', 'subagents'], execute: () => agents.list() }),
    schemaTool({ name: 'subagent_status', schema: SubagentStatusSchema, capabilities: ['read', 'subagents'], execute: args => agents.statusOf(args.subagent_id) }),
    schemaTool({ name: 'stop_subagent', schema: StopSubagentSchema, capabilities: ['subagents'], execute: args => agents.stopJob(args.subagent_id) }),
  ];
}
