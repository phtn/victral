import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';
import { IntegrationConfigsSchema, parseIntegrations } from '../src/integration-config.js';
import { loadIntegrations, Integrations } from '../src/integrations.js';
import { ValidationError } from '../src/core/errors.js';

test('MCP schemas preserve both transports, exact allowlists, defaults and top-level metadata', () => {
  const parsed = parseIntegrations({ metadata: { version: 1 }, servers: {
    stdio: { command: ' node ', args: ['', '--stdio', '🦓'], env: { TEST_KEY: 'MCP_TEST_KEY' }, allowTools: ['lookup', 'Lookup', '*', 'lookup'] },
    http: { url: 'https://example.test/mcp', headers: { Authorization: 'MCP_TOKEN', 'X-API-Key': 'API_KEY' } },
    empty: { command: 'node', args: undefined, env: undefined, url: undefined, headers: undefined, allowTools: undefined },
  } });
  expect(Object.getPrototypeOf(parsed)).toBe(null);
  expect(parsed.stdio).toEqual({ command: ' node ', args: ['', '--stdio', '🦓'], env: { TEST_KEY: 'MCP_TEST_KEY' }, allowTools: ['lookup', 'Lookup', '*', 'lookup'] });
  expect(parsed.http).toEqual({ url: 'https://example.test/mcp', headers: { Authorization: 'MCP_TOKEN', 'X-API-Key': 'API_KEY' }, allowTools: [] });
  expect(parsed.empty?.allowTools).toEqual([]);
  expect(parseIntegrations({ servers: {} })).toEqual({});
  const encoded = Schema.encodeSync(IntegrationConfigsSchema)(parsed);
  expect(parseIntegrations({ servers: encoded })).toEqual(parsed);
});

test('MCP schemas enforce identifier and server-count bounds without dropping invalid keys', () => {
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`server${i}`, { command: 'node' }]));
  expect(Object.keys(parseIntegrations({ servers: sixteen }))).toHaveLength(16);
  expect(() => parseIntegrations({ servers: { ...sixteen, extra: { command: 'node' } } })).toThrow('At most 16');
  for (const name of ['', '_bad', 'bad.name', 'a'.repeat(65), '0bad', 'bad name']) {
    expect(() => parseIntegrations({ servers: { [name]: { command: 'node' } } })).toThrow(ValidationError);
  }
  const special = parseIntegrations({ servers: { ['a'.repeat(64)]: { command: 'node' }, constructor: { command: 'node' }, toString: { command: 'node' } } });
  expect(Object.entries(special).find(([name]) => name === 'constructor')?.[1]).toEqual({ command: 'node', allowTools: [] });
});

test('MCP schemas reject invalid envelopes, unknown fields, wrong transports and malformed arguments', () => {
  for (const value of [null, [], {}, { servers: null }, { servers: [] }, { servers: 'bad' }]) {
    expect(() => parseIntegrations(value)).toThrow(ValidationError);
  }
  for (const server of [null, [], {}, { command: 'node', url: 'https://example.test' },
    { command: '' }, { command: '   ' }, { command: 'node\0' }, { command: 42 },
    { command: 'node', args: 'server.js' }, { command: 'node', args: [42] }, { command: 'node', args: ['a\0'] },
    { command: 'node', headers: {} }, { command: 'node', unknown: true }, { command: 'node', unknown: undefined },
    { url: 'https://example.test', env: {} }, { url: 'https://example.test', args: [] },
    { url: 'file:///tmp/server' }, { url: '/relative' }, { url: 'https://user:secret@example.test' },
    { url: null }, { command: 'node', url: null },
  ]) expect(() => parseIntegrations({ servers: { bad: server } })).toThrow(ValidationError);
});

test('MCP schemas reject literal credentials and invalid reference keys without echoing values', () => {
  for (const refs of [null, [], { Authorization: 'Bearer fixture-sensitive-value' }, { 'Invalid-Key!': 'VALID_REF' },
    { VALID_KEY: 'INVALID-REF' }, { VALID_KEY: '' }, { VALID_KEY: 42 }, { VALID_KEY: undefined }]) {
    for (const server of [{ command: 'node', env: refs }, { url: 'https://example.test', headers: refs }]) {
      const error = (() => { try { parseIntegrations({ servers: { docs: server } }); } catch (error) { return error; } })();
      expect(error).toBeInstanceOf(ValidationError);
      if (error instanceof ValidationError) {
        expect(error.message).not.toContain('fixture-sensitive-value');
        expect(error.message).toContain('docs');
        expect(error.cause).toBeInstanceOf(Schema.SchemaError);
      }
    }
  }
});

test('MCP schemas retain exact tool-name limits and fail before connecting or resolving environment', async () => {
  expect(parseIntegrations({ servers: { docs: { command: 'node', allowTools: ['a'.repeat(200)] } } }).docs?.allowTools).toHaveLength(1);
  for (const allowTools of [null, '*', [''], ['a'.repeat(201)], [1], [undefined]]) {
    expect(() => parseIntegrations({ servers: { docs: { command: 'node', allowTools } } })).toThrow(ValidationError);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-config-'));
  try {
    const file = path.join(directory, 'mcp.json');
    await fs.writeFile(file, JSON.stringify({ servers: { docs: { command: 'nonexistent-fixture-executable', env: { SECRET: 'UNSET_MCP_FIXTURE' }, allowTools: [''] } } }));
    await expect(loadIntegrations(file, directory)).rejects.toThrow(ValidationError);
    // '*' remains an exact name, never a wildcard permission.
    const integrations = new Integrations(parseIntegrations({ servers: { docs: { command: 'nonexistent-fixture-executable', allowTools: ['*'] } } }), directory);
    try {
      await expect(integrations.execute('call_integration_tool', { server: 'docs', tool: 'lookup', arguments: {} })).rejects.toThrow('not enabled');
      expect(integrations.list()).toContain('"connected": false');
    } finally { await integrations.close(); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
