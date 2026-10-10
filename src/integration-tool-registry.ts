import type { Integrations } from './integrations.js';
import { ListIntegrationsSchema, ListIntegrationToolsSchema, CallIntegrationToolSchema } from './integration-tool-schema.js';
import { schemaTool } from './tool-registry.js';

export function integrationTools(integrations: Pick<Integrations, 'list' | 'checkCallAccess' | 'discoverTools' | 'callTool'>) {
  return [
    schemaTool({ name: 'list_integrations', schema: ListIntegrationsSchema, capabilities: ['read', 'integrations'], execute: () => integrations.list() }),
    schemaTool({ name: 'list_integration_tools', schema: ListIntegrationToolsSchema, capabilities: ['read', 'integrations'], execute: (args, signal) => integrations.discoverTools(args, signal) }),
    schemaTool({ name: 'call_integration_tool', schema: CallIntegrationToolSchema, capabilities: ['integrations'],
      beforeDecode: value => integrations.checkCallAccess(value), execute: (args, signal) => integrations.callTool(args, signal),
    }),
  ];
}
