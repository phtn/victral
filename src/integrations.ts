import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { capResult } from './constants.js';
import { errorMessage } from './types.js';
import { httpURL } from './web-browser.js';

export interface IntegrationConfig {
  command?: string; args?: string[]; url?: string;
  env?: Record<string, string>; headers?: Record<string, string>; allowTools: string[];
}
export type IntegrationConfigs = Record<string, IntegrationConfig>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseIntegrations(value: unknown): IntegrationConfigs {
  if (!object(value) || !object(value.servers)) throw new Error('MCP config must contain a servers object.');
  if (Object.keys(value.servers).length > 16) throw new Error('At most 16 MCP servers may be configured.');
  const configs: IntegrationConfigs = Object.create(null);
  for (const [name, server] of Object.entries(value.servers)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !object(server)) throw new Error('MCP server names must be simple identifiers and entries must be objects.');
    if (Object.keys(server).some(key => !['command', 'args', 'url', 'env', 'headers', 'allowTools'].includes(key))) throw new Error(`Unknown MCP configuration field for ${name}.`);
    const command = server.command, url = server.url;
    if ((command === undefined) === (url === undefined)) throw new Error(`${name} needs exactly one of command or url.`);
    if (command !== undefined && (typeof command !== 'string' || !command.trim() || command.includes('\0'))) throw new Error(`${name}: command must be nonempty text.`);
    if (url !== undefined) httpURL(url);
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(arg => typeof arg === 'string' && !arg.includes('\0')))) throw new Error(`${name}: args must be an array of strings.`);
    if (url !== undefined && (server.args !== undefined || server.env !== undefined)) throw new Error(`${name}: args and env are for local servers.`);
    if (command !== undefined && server.headers !== undefined) throw new Error(`${name}: headers are for HTTP servers.`);
    for (const key of ['env', 'headers']) {
      const refs = server[key];
      if (refs !== undefined && (!object(refs) || !Object.entries(refs).every(([target, ref]) => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(target) && typeof ref === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ref)))) throw new Error(`${name}: ${key} maps names to environment variable names, not literal secrets.`);
    }
    if (server.allowTools !== undefined && (!Array.isArray(server.allowTools) || !server.allowTools.every(tool => typeof tool === 'string' && !!tool && tool.length <= 200))) throw new Error(`${name}: allowTools must list exact tool names.`);
    configs[name] = { ...server, allowTools: server.allowTools ?? [] } as IntegrationConfig;
  }
  return configs;
}
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
