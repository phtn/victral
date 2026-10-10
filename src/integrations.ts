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
  private clients = new Map<string, Client>();
  private pending = new Map<string, Promise<Client>>();
  private secrets = new Set<string>();
  private closing = false;
  private lifetime = new AbortController();
  constructor(private config: IntegrationConfigs, private project: string) {}
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
      transport: config.url ? 'http' : 'stdio', connected: this.clients.has(name), enabled_tools: config.allowTools })), null, 2);
  }
  private async client(name: string, signal?: AbortSignal): Promise<Client> {
    if (this.closing) throw new Error('Integrations are closed.');
    signal?.throwIfAborted();
    const config = this.config[name];
    if (!Object.hasOwn(this.config, name)) throw new Error(`Unknown integration: ${name}. Use list_integrations.`);
    if (this.clients.has(name)) return this.clients.get(name)!;
    if (this.pending.has(name)) return this.pending.get(name)!;
    const client = new Client({ name: 'victral', version: '0.2.0' }, { capabilities: {} });
    const transport = config.url
      ? new StreamableHTTPClientTransport(httpURL(config.url), { requestInit: { headers: this.references(config.headers), redirect: 'error' } })
      : new StdioClientTransport({ command: config.command!, args: config.args, cwd: this.project,
        env: { ...getDefaultEnvironment(), ...this.references(config.env) }, stderr: 'ignore', maxBufferSize: 2_000_000 });
    const work = (async () => {
      try {
        await client.connect(transport, { timeout: 15_000, signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal });
        if (this.closing) throw new Error('Integrations are closed.');
        this.clients.set(name, client);
        client.onclose = () => { if (this.clients.get(name) === client) this.clients.delete(name); };
        return client;
      } catch (error) {
        await client.close().catch(() => {}); await transport.close().catch(() => {});
        throw new Error(this.redact(errorMessage(error)));
      } finally { this.pending.delete(name); }
    })();
    this.pending.set(name, work);
    return work;
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
    const client = await this.client(args.server, signal);
    const options = { timeout: 30_000, signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal };
    try {
      const tools = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, options);
        tools.push(...page.tools.map(tool => ({ ...tool, enabled: config.allowTools.includes(tool.name) })));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('MCP server repeated its tool-list cursor.');
        if (cursor) cursors.add(cursor);
        if (tools.length > 500) throw new Error('MCP tool list exceeds 500 tools.');
      } while (cursor);
      return this.redact(JSON.stringify({ server: args.server, tools }, null, 2));
    } catch (error) { throw new Error(this.redact(errorMessage(error))); }
  }
  async callTool(args: CallIntegrationToolArgs, signal?: AbortSignal): Promise<string> {
    // Prepared calls may outlive a permission change. Recheck the exact name
    // immediately before acquisition; never treat '*' as a wildcard.
    this.checkToolAccess(args.server, args.tool);
    const client = await this.client(args.server, signal);
    const options = { timeout: 30_000, signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal };
    try {
      const result = await client.callTool({ name: args.tool, arguments: args.arguments }, undefined, options);
      const content = (Array.isArray(result.content) ? result.content : []).map((block: Record<string, unknown>) => block.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify({ type: block.type, note: 'Non-text content omitted; use a specialized client to view it.' })).join('\n');
      const output = this.redact(content || JSON.stringify(result.structuredContent ?? {}));
      if (result.isError) throw new Error(`Integration tool failed: ${output}`);
      return output;
    } catch (error) { throw new Error(this.redact(errorMessage(error))); }
  }
  async close(): Promise<void> {
    this.closing = true; this.lifetime.abort();
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    this.clients.clear();
  }
}
