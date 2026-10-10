import * as Schema from 'effect/Schema';
import { validationDecoder } from './core/schema.js';
import { ArgumentsObjectSchema, textArgument } from './tool-argument-schema.js';

const Server = textArgument('server', 'server must be a configured integration name.');
const Tool = textArgument('tool', 'This integration tool is not enabled. Add its exact name to allowTools in your MCP config.');
export const ListIntegrationsSchema = ArgumentsObjectSchema;
export const ListIntegrationToolsSchema = Schema.Struct({ server: Server });
// Discovered remote schemas stay in their native JSON form. Validate the local envelope;
// preserve every payload key and nested value, including extensible metadata.
export const CallIntegrationToolSchema = Schema.Struct({ server: Server, tool: Tool,
  arguments: Schema.Record(Schema.String, Schema.Unknown).annotate({ identifier: 'arguments must be an object.' })
    .annotateKey({ messageMissingKey: 'arguments must be an object.' }),
});
export type ListIntegrationToolsArgs = typeof ListIntegrationToolsSchema.Type;
export type CallIntegrationToolArgs = typeof CallIntegrationToolSchema.Type;

export const parseListIntegrations = validationDecoder(ListIntegrationsSchema, 'list_integrations arguments');
export const parseListIntegrationTools = validationDecoder(ListIntegrationToolsSchema, 'list_integration_tools arguments');
export const parseCallIntegrationTool = validationDecoder(CallIntegrationToolSchema, 'call_integration_tool arguments');
// Partial decoders preserve server/allowlist denial precedence before the full
// call envelope is decoded. These checks must never acquire an MCP client.
export const parseIntegrationCallServer = validationDecoder(ListIntegrationToolsSchema, 'call_integration_tool arguments');
export const parseIntegrationToolName = validationDecoder(Schema.Struct({ tool: Tool }), 'call_integration_tool arguments');
