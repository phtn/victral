import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { capResult } from './constants.js';
import { errorMessage } from './types.js';
import { httpURL } from './web-browser.js';
import { parseIntegrations, type IntegrationConfigs } from './integration-config.js';
export { parseIntegrations } from './integration-config.js';
export type { IntegrationConfig, IntegrationConfigs } from './integration-config.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
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
  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (name === 'list_integrations') return this.list();
    if (typeof args.server !== 'string') throw new Error('server must be a configured integration name.');
    const config = this.config[args.server];
    if (!Object.hasOwn(this.config, args.server)) throw new Error(`Unknown integration: ${args.server}.`);
    if (name === 'call_integration_tool' && (typeof args.tool !== 'string' || !config.allowTools.includes(args.tool))) throw new Error('This integration tool is not enabled. Add its exact name to allowTools in your MCP config.');
    const client = await this.client(args.server, signal);
    const options = { timeout: 30_000, signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal };
    try {
      if (name === 'list_integration_tools') {
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
      }
      if (name === 'call_integration_tool') {
        if (!object(args.arguments)) throw new Error('arguments must be an object.');
        const result = await client.callTool({ name: args.tool as string, arguments: args.arguments }, undefined, options);
        const content = (Array.isArray(result.content) ? result.content : []).map((block: Record<string, unknown>) => block.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify({ type: block.type, note: 'Non-text content omitted; use a specialized client to view it.' })).join('\n');
        const output = this.redact(content || JSON.stringify(result.structuredContent ?? {}));
        if (result.isError) throw new Error(`Integration tool failed: ${output}`);
        return output;
      }
      throw new Error(`Unknown integration operation: ${name}.`);
    } catch (error) { throw new Error(this.redact(errorMessage(error))); }
  }
  async close(): Promise<void> {
    this.closing = true; this.lifetime.abort();
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    this.clients.clear();
  }
}
