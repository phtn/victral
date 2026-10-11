import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import { Mcp, McpFailure, acquireMcpResource, type McpFactory, type McpOptions } from './core/mcp.js';
import { acquireMcpFetch } from './core/mcp-http.js';
import { toExternalPromise } from './core/external-io.js';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { capResult } from './constants.js';
import { errorMessage } from './types.js';
import { httpURL } from './web-browser.js';
import { parseIntegrations, type IntegrationConfigs } from './integration-config.js';
import { parseListIntegrations, parseListIntegrationTools, parseCallIntegrationTool, parseIntegrationCallServer, parseIntegrationToolName,
  type ListIntegrationToolsArgs, type CallIntegrationToolArgs } from './integration-tool-schema.js';
export { parseIntegrations } from './integration-config.js';
export type { IntegrationConfig, IntegrationConfigs } from './integration-config.js';

export async function loadIntegrations(filename: string, project: string): Promise<Integrations> {
  const config = parseIntegrations(JSON.parse(await fs.readFile(filename, 'utf8')));
  return new Integrations(config, project);
}

export class Integrations {
  private readonly scope = Scope.makeUnsafe();
  private readonly mcp;
  private closePromise?: Promise<void>;
  private secrets = new Set<string>();
  private closing = false;
  constructor(private config: IntegrationConfigs, private project: string,
    options: McpOptions & { factory?: McpFactory; fetchImpl?: typeof fetch } = {}) {
    const failure = (operation: string, cause: unknown) => new McpFailure({ operation, cause, message: this.redact(errorMessage(cause)) });
    const owner = this;
    const factory: McpFactory = options.factory ?? ((name, context) => Effect.gen(function*() {
      const httpFetch = config[name]!.url ? yield* acquireMcpFetch(context, options.fetchImpl) : undefined;
      return yield* acquireMcpResource(
        () => new Client({ name: 'victral', version: '0.2.0' }, { capabilities: {} }),
        () => {
          const config = owner.config[name]!;
          return config.url
            ? new StreamableHTTPClientTransport(httpURL(config.url), {
              requestInit: { headers: owner.references(config.headers), redirect: 'error' },
              fetch: httpFetch,
            })
            : new StdioClientTransport({ command: config.command!, args: config.args, cwd: owner.project,
              env: { ...getDefaultEnvironment(), ...owner.references(config.env) }, stderr: 'ignore', maxBufferSize: 2_000_000 });
        }, cause => failure('MCP connection', cause));
    }));
    this.mcp = Effect.runSync(Mcp.acquire(factory, failure, options).pipe(Effect.provideService(Scope.Scope, this.scope)));
  }
  private redact(text: string): string {
    for (const secret of this.secrets) text = text.replaceAll(secret, '[redacted]');
    return capResult(text);
  }
  private references(refs: Record<string, string> = {}): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs)) {
      const value = process.env[ref];
      if (!value) throw new Error(`Set ${ref} before using this MCP server.`);
      this.secrets.add(value); values[name] = value;
    }
    return values;
  }
  list(): string {
    return JSON.stringify(Object.entries(this.config).map(([name, config]) => ({ name,
      transport: config.url ? 'http' : 'stdio', connected: this.mcp.connected(name), enabled_tools: config.allowTools })), null, 2);
  }
  private serverConfig(server: string) {
    if (!Object.hasOwn(this.config, server)) throw new Error(`Unknown integration: ${server}.`);
    return this.config[server]!;
  }
  private checkToolAccess(server: string, tool: string): void {
    if (!this.serverConfig(server).allowTools.includes(tool)) throw new Error('This integration tool is not enabled. Add its exact name to allowTools in your MCP config.');
  }
  checkCallAccess(value: unknown): void {
    const { server } = parseIntegrationCallServer(value);
    this.serverConfig(server);
    this.checkToolAccess(server, parseIntegrationToolName(value).tool);
  }
  async execute(name: string, value: unknown, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (name === 'list_integrations') { parseListIntegrations(value); return this.list(); }
    if (name === 'list_integration_tools') return this.discoverTools(parseListIntegrationTools(value), signal);
    if (name === 'call_integration_tool') {
      this.checkCallAccess(value);
      return this.callTool(parseCallIntegrationTool(value), signal);
    }
    throw new Error(`Unknown integration operation: ${name}.`);
  }
  async discoverTools(args: ListIntegrationToolsArgs, signal?: AbortSignal): Promise<string> {
    const config = this.serverConfig(args.server);
    if (this.closing) throw new Error('Integrations are closed.');
    const mcp = this.mcp, redact = this.redact.bind(this);
    return toExternalPromise(Effect.gen(function*() {
      const tools = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        // Each discovery page keeps its own call deadline, as in the SDK API.
        const page = yield* mcp.request(args.server, 'MCP tool discovery',
          (client, options) => client.listTools(cursor ? { cursor } : {}, options));
        tools.push(...page.tools.map(tool => ({ ...tool, enabled: config.allowTools.includes(tool.name) })));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) return yield* Effect.fail(new McpFailure({ operation: 'MCP tool discovery',
          message: 'MCP server repeated its tool-list cursor.', cause: undefined }));
        if (cursor) cursors.add(cursor);
        if (tools.length > 500) return yield* Effect.fail(new McpFailure({ operation: 'MCP tool discovery',
          message: 'MCP tool list exceeds 500 tools.', cause: undefined }));
      } while (cursor);
      return redact(JSON.stringify({ server: args.server, tools }, null, 2));
    }), signal);
  }
  async callTool(args: CallIntegrationToolArgs, signal?: AbortSignal): Promise<string> {
    // Prepared calls may outlive a permission change. Recheck the exact name
    // immediately before acquisition; never treat '*' as a wildcard.
    this.checkToolAccess(args.server, args.tool);
    if (this.closing) throw new Error('Integrations are closed.');
    return toExternalPromise(this.mcp.request(args.server, 'MCP tool call', async (client, options) => {
      const result = await client.callTool({ name: args.tool, arguments: args.arguments }, undefined, options);
      const content = (Array.isArray(result.content) ? result.content : []).map((block: Record<string, unknown>) => block.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify({ type: block.type, note: 'Non-text content omitted; use a specialized client to view it.' })).join('\n');
      const output = this.redact(content || JSON.stringify(result.structuredContent ?? {}));
      if (result.isError) throw new Error(`Integration tool failed: ${output}`);
      return output;
    }), signal);
  }
  close(): Promise<void> {
    this.closing = true;
    return this.closePromise ??= toExternalPromise(Scope.close(this.scope, Exit.void));
  }
}
