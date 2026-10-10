import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { ValidationError } from './core/errors.js';
import { httpURL } from './web-browser.js';

const ServerName = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/));
const ReferenceTarget = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_-]*$/));
const EnvironmentVariable = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/,
  { message: 'Use an environment variable name, not a literal secret.' }));
const References = Schema.Record(ReferenceTarget, EnvironmentVariable);
const Argument = Schema.String.check(Schema.makeFilter(value => !value.includes('\0'), { message: 'Arguments must not contain NUL.' }));
const Command = Argument.check(Schema.makeFilter(value => !!value.trim(), { message: 'command must be nonempty text.' }));
const HTTPURL = Schema.String.check(Schema.makeFilter(value => {
  try { httpURL(value); return true; } catch { return false; }
}, { message: 'Expected an absolute HTTP(S) URL without embedded credentials.' }));
const AllowTools = Schema.Array(Schema.String.check(Schema.isBetweenLength(1, 200))).pipe(
  Schema.mutable,
  // Legacy callers accept missing keys and explicit undefined, but never null.
  Schema.withDecodingDefault(Effect.succeed([])),
);
const Forbidden = Schema.optional(Schema.Never);

export const IntegrationConfigSchema = Schema.Union([
  Schema.Struct({ command: Command, args: Schema.optional(Schema.Array(Argument).pipe(Schema.mutable)),
    env: Schema.optional(References), allowTools: AllowTools, url: Forbidden, headers: Forbidden }),
  Schema.Struct({ url: HTTPURL, headers: Schema.optional(References), allowTools: AllowTools,
    command: Forbidden, args: Forbidden, env: Forbidden }),
]);
export type IntegrationConfig = typeof IntegrationConfigSchema.Type;
export const IntegrationConfigsSchema = Schema.Record(ServerName, IntegrationConfigSchema).check(
  Schema.makeFilter(servers => Object.keys(servers).length <= 16, { message: 'At most 16 MCP servers may be configured.' }),
);
export type IntegrationConfigs = typeof IntegrationConfigsSchema.Type;

// Ignore top-level metadata as before; reject unknown server fields and unmatched
// dictionary keys explicitly. A refined Record key otherwise drops invalid keys.
const ConfigEnvelope = Schema.Struct({ servers: Schema.Record(Schema.String, Schema.Unknown) });
const decodeEnvelope = Schema.decodeUnknownResult(ConfigEnvelope, { onExcessProperty: 'ignore', reportInput: false });
const decodeServers = Schema.decodeUnknownResult(IntegrationConfigsSchema, { onExcessProperty: 'error', reportInput: false, errors: 'all' });
const invalid = (cause: Schema.SchemaError) => new ValidationError({ boundary: 'MCP configuration',
  message: `Invalid MCP configuration: ${cause.message}`, cause });

export function parseIntegrations(value: unknown): IntegrationConfigs {
  const envelope = decodeEnvelope(value);
  if (Result.isFailure(envelope)) throw invalid(envelope.failure);
  const servers = decodeServers(envelope.success.servers);
  if (Result.isFailure(servers)) throw invalid(servers.failure);
  // Preserve own-key lookup semantics for names such as constructor/toString.
  return Object.assign(Object.create(null), servers.success);
}
