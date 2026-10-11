# Effect Schema patterns for Victral

Use the vendored Effect source as reference material, and import application
code from normal package dependencies. `@repos/` in `AGENTS.md` means the
repository's `repos/` directory; it is not a TypeScript import alias.
Never import from or edit `repos/effect` when implementing application features.

The reference checkout identifies itself as Effect **4.0.3**. Victral pins the
published **4.0.2** package, with application compilation and runtime tests
verifying the v4 APIs used here. The reference version is not yet published at
the initial migration check. See the [baseline](../docs/EFFECT_MIGRATION_BASELINE.md)
for verification and the [runtime conventions](effect-runtime.md) for errors
and adapters. Do not assume that a v3 package implements these signatures.

## Reference material

Review these files before writing related code:

- [Schema guide](../repos/effect/packages/effect/SCHEMA.md): constructors,
  optional fields, codecs, transformations, and error handling.
- [Schema implementation](../repos/effect/packages/effect/src/Schema.ts):
  signatures, supported services, and JSDoc examples.
- [Schema runtime tests](../repos/effect/packages/effect/test/Schema/Schema.test.ts):
  success, rejection, parse options, round trips, and formatted errors.
- [Schema basics](../repos/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts):
  domain classes, reusable parsers, and typed application errors.
- [SchemaGetter tests](../repos/effect/packages/effect/test/Schema/SchemaGetter.test.ts)
  and [implementation](../repos/effect/packages/effect/src/SchemaGetter.ts):
  pure, optional, and effectful transformation getters.

## Constructors and combinators

Define schemas once at module scope, derive types from them, and build reusable
parsers. Use `unknown` at external boundaries such as JSON files, HTTP responses,
storage records, and tool arguments.

```ts
import { Schema } from "effect"

const Retries = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Settings = Schema.Struct({
  provider: Schema.Literals(["meta", "openai"]),
  model: Schema.NonEmptyString,
  retries: Retries,
  tags: Schema.Array(Schema.String),
  description: Schema.optionalKey(Schema.String)
})

type SettingsType = typeof Settings.Type
// With codecs, Type and Encoded can differ.
type SettingsEncoded = typeof Settings.Encoded

const TextOrCount = Schema.Union([Schema.String, Schema.Int])
const Point = Schema.Tuple([Schema.Finite, Schema.Finite])
const NullableName = Schema.NullOr(Schema.String)
```

Use `Struct` for records with known fields, `Record` for dictionaries,
`Array`/`Tuple` for collections, and `Literal`/`Literals` for fixed values.
`Union` takes an array of members in this checkout. Struct fields are readonly
and required by default. `optionalKey(S)` permits absence but rejects explicit
`undefined`; `optional(S)` permits both. Add `NullOr(S)` only when `null` is part
of the contract. These distinctions matter when reading configuration files.

Use `Finite` rather than unrestricted `Number` when JSON or the domain requires
finite numbers. Add built-in checks with `.check(...)` or
`.pipe(Schema.check(...))`; avoid reconstructing standard checks by hand.
In this v4 API, `Schema.Int`/`Schema.isInt()` enforce `Number.isSafeInteger`,
including the safe range. Also check generated revisions before durable writes;
validating an incoming revision does not make its increment safe.

Refined `Record` keys select properties: unmatched keys are ignored by default.
Use `onExcessProperty: "error"` when every key must be valid, such as MCP server
names and environment-reference targets. This follows the vendored `Record`
tests. For different policies at different levels, decode those boundaries
separately: MCP permits top-level metadata but rejects unknown server fields.
Do not assume a custom `parseOptions` annotation changes the parser's options.

## Decoding and encoding

This example adapts the built-in string/number codec documented in `Schema.ts`:

```ts
import { Schema } from "effect"

const Count = Schema.FiniteFromString
const decodeCount = Schema.decodeUnknownSync(Count)
const encodeCount = Schema.encodeSync(Count)

const count = decodeCount("42") // number: 42
const wire = encodeCount(count) // string: "42"
```

`NumberFromString` also accepts non-finite values; choose `FiniteFromString`
when those would be invalid. Encoding is the codec's reverse operation,
not a cast and not necessarily identity.

Choose the adapter for the surrounding code:

| Boundary | Decode | Encode |
| --- | --- | --- |
| Effect workflow | `decodeUnknownEffect` | `encodeEffect` |
| Promise workflow | `decodeUnknownPromise` | `encodePromise` |
| Synchronous, throwing | `decodeUnknownSync` | `encodeSync` |
| Synchronous, explicit failure | `decodeUnknownResult` | `encodeResult` |

Use `decodeEffect` instead of `decodeUnknownEffect` when input already has the
schema's `Encoded` type. Use `encodeUnknownEffect` for unknown values on the
encoding boundary. Schemas with asynchronous work or required services need
appropriate Effect/Promise adapters and supplied services; synchronous adapters
must not be used to bypass those requirements.

For strict configuration, select parse options explicitly:

```ts
const decodeSettings = Schema.decodeUnknownEffect(Settings, {
  onExcessProperty: "error",
  errors: "all",
  reportInput: false
})
```

This adapts excess-property cases from `Schema.test.ts`. Do not assume unknown
keys are rejected by default. Choose ignore or error behavior deliberately
and test it against the external contract.

The first production example is [integration-config.ts](../src/integration-config.ts).
It uses a `Union` of stdio and HTTP structs, `optional(Never)` for fields forbidden
on a transport, bounded exact tool names, and
`withDecodingDefault(Effect.succeed([]))` for the discovery-only allowlist.
That default deliberately accepts both an absent key and explicit `undefined`,
matching legacy callers. It rejects `null`. Use `withDecodingDefaultKey` when
only absence should trigger the default. Preserve exact tool-name matching;
`["*"]` permits only a tool literally named `*`.

## Transformations

Prefer built-in codecs before adding a custom transformation. `decodeTo` and
`SchemaGetter` define both directions when an external shape differs from the
domain shape. This adapts the `Struct & flip & check & flip` runtime test:

```ts
import { Schema, SchemaGetter } from "effect"

const Renamed = Schema.Struct({ b: Schema.String }).pipe(
  Schema.decodeTo(Schema.Struct({ a: Schema.String }), {
    decode: SchemaGetter.transform((wire) => ({ a: wire.b })),
    encode: SchemaGetter.transform((domain) => ({ b: domain.a }))
  })
)

const domain = Schema.decodeUnknownSync(Renamed)({ b: "hello" })
// { a: "hello" }
const wire = Schema.encodeSync(Renamed)(domain)
// { b: "hello" }
```

`decode` maps the source's decoded value to the target's encoded value;
`encode` maps the target's encoded value back to the source's decoded value.
Keep both directions explicit and test decode and encode independently.
Use `SchemaGetter.transformEffect` for transformations requiring effects or
services. Report expected validation failures through schema issues rather
than throwing arbitrary exceptions inside a pure getter. Optional-field
transformations require the optional getter patterns in the reference guide;
do not substitute missing fields with unchecked defaults.

The [task-plan schemas](../src/task-plan-schema.ts) adapt the vendored trim and
`StructWithRest` examples. Keep limits on raw text before trimming when that is
the existing boundary contract:

```ts
import { Schema, SchemaTransformation } from "effect"

const StepText = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.makeFilter((text) => !!text.trim(), { message: "Step text must not be blank." })
).pipe(Schema.decodeTo(Schema.Trimmed, SchemaTransformation.trim()))

const step = Schema.decodeUnknownSync(StepText)("  Inspect code  ") // "Inspect code"
const encoded = Schema.encodeSync(StepText)(step) // "Inspect code"
```

Keep the source schema in the pipeline so its encoded type and required services
remain inferred. This trim codec normalizes text; encoding cannot recover the
original whitespace. Task-plan updates trim titles and steps, while saved-plan
decoding trims steps and preserves saved title whitespace and date strings.
Validate a saved date string with the established `Date.parse` rule when the
durable contract permits it; replacing it with a Date-object codec changes the
record shape.

Use `StructWithRest(Struct(fields), [Record(String, Unknown)])` for explicitly
extensible saved metadata. Select records belonging to the current project
before strict validation. Tool-input and step extras are deliberately ignored.
Schemas may rebuild object key order: `TaskPlans` overwrites raw saved fields
with decoded values while retaining the original rendering order, verified
against a fixture captured from the previous implementation. Revision conflicts
and strictly increasing saved revisions remain explicit state-dependent checks;
validation and durable save finish before publishing new state.

The [audio settings](../src/sfx/settings.ts) use decoding defaults for missing
or undefined volume/mute values, reject null and unknown setting keys, and check
finite volume before changing state or starting playback. Validate UI deltas
before clamping; clamping alone can turn infinity into an apparently valid
setting or let NaN reach the player.

The [browsing schemas](../src/web-tool-schema.ts) preserve a different null
contract: numeric tool options historically use `??`, so they accept null as a
request for the default. Adapted from the custom-default and transformation
patterns in `SCHEMA.md` and `SchemaTransformation.ts`:

```ts
import { Effect, Schema, SchemaTransformation } from "effect"

const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 }))
const DefaultTimeout = Schema.NullOr(Timeout).pipe(
  Schema.decodeTo(Timeout, SchemaTransformation.transform({
    decode: (value) => value ?? 30_000,
    encode: (value) => value
  })),
  Schema.withDecodingDefault(Effect.succeed(30_000))
)

const Args = Schema.Struct({ timeout_ms: DefaultTimeout })
Schema.decodeUnknownSync(Args)({ timeout_ms: null }) // { timeout_ms: 30000 }
```

URL arguments adapt `SchemaTransformation.urlFromString`: validate the existing
protocol/credential policy on the source string, then decode to `Schema.URL`.
Encoding returns the canonical URL string. Do not silently tighten the input
contract during migration: browsing rejects embedded credentials, whereas the
legacy raw-fetch tool accepts them. Page IDs still require a session-state
lookup after decoding, and search queries preserve whitespace after rejecting
blank text.

Use [schemaTool and ToolRegistry](../src/tool-registry.ts) to bind a schema to a
handler accepting its inferred decoded type. Registry capability checks run
before decoding; schema decoding runs before invoking the handler. `prepare()`
validates and captures arguments without starting work, so parallel batches can
prepare all registered inputs before I/O. Schema errors reject the batch during
preflight; runtime errors such as missing pages/files remain individual results.
Every enabled project tool, including the batch envelope, uses this registry.
Accept `unknown` at `AgentTools.execute` and Promise/Effect adapters; let schemas
establish the argument type rather than asserting a parsed JSON record.
Keep provider-facing definitions in `tools.ts` unchanged;
they are frozen request fixtures and are not generated from these codecs.

Legacy `WebBrowser.open/read/find` calls decode unknown values and delegate to
the same typed implementations used by the registry. Registry handlers must
call those implementations with decoded arguments to avoid parsing twice.

The [file/Git read schemas](../src/read-tool-schema.ts) reuse
[argument combinators](../src/tool-argument-schema.ts) for safe integer bounds,
nullish numeric defaults, missing/undefined-only boolean defaults, and useful
field messages. Derive Git handler types from those schemas. `GitTools.execute`
adapts unknown inputs to typed methods; the registry calls the typed methods
directly. Preserve the distinction between structural and state-dependent rules:
filesystem containment and symlink checks still run through `resolveFile`, and
memory alignment/history checks still return `Memory.zoom`'s domain results.

For `read_file`, retain `optional(NullOr(Line))` on each line option. Absent or
undefined options request raw text, while explicit null requests numbered text
with defaults. The end default depends on file length and stays in the handler;
normalizing all absent/null options during decoding would change output. Git
blame differs: line options reject null and must be supplied together.

Attach cross-field failures to the relevant field using `makeFilter`'s pointer
form, adapted from the nested-path examples in `Schema.ts` and its runtime tests:

```ts
const Range = Schema.Struct({ start_line: Schema.Int, end_line: Schema.Int }).check(
  Schema.makeFilter((args) => args.end_line < args.start_line
    ? { path: ["end_line"], issue: "end_line must not precede start_line." }
    : undefined)
)
```

Validate regex syntax only when regex mode is enabled. Keep literal queries and
whitespace intact; compiling a literal query would reject valid searches. Regex
execution remains in the existing worker with its deadline and cancellation.
Keep Git references as strings with the existing option/NUL/newline exclusions;
actual revision existence belongs to Git. Preserve literal pathspecs, native
argument arrays and Git flags rather than constructing shell strings.

For a no-argument tool, use `Record(String, Unknown)` to require an arguments
object and let the handler ignore its keys. Do not use `Struct({})` as an object
guard: this Effect version accepts non-null primitives for that empty TypeScript
shape. Arrays and null must fail before the tool runs.

The [mutation schemas](../src/mutation-tool-schema.ts) preserve literal file
contents and replacement text. Adapted from the vendored `isMinLength` runtime
test and `Schema.ts` example:

```ts
import * as Schema from "effect/Schema"

const EditArguments = Schema.Struct({
  path: Schema.String,
  old_text: Schema.String.check(Schema.isMinLength(1)),
  new_text: Schema.String
})
type EditArgumentsType = typeof EditArguments.Type

Schema.decodeUnknownSync(EditArguments)({
  path: "file.txt", old_text: "  ", new_text: ""
}) // whitespace is searchable; an empty replacement deletes it
```

Do not trim these strings, use nonblank filters, or reject NUL/Unicode text.
`write_file` accepts empty content; `edit_file` rejects only empty search text.
Path containment and symlinks remain the resolver's responsibility. Patch Schema
validates the string envelope; the existing pure parser checks grammar before
filesystem access, and the patch engine retains context matching, preflight,
file modes, newline handling and rollback. These are different boundaries.

Plan updates require a state-dependent revision check before full payload
validation to preserve conflict precedence. The registry's synchronous,
read-only `beforeDecode` hook decodes the revision envelope and checks current
state after capability authorization. It must not start I/O or return a Promise.
The handler receives the complete decoded `UpdatePlanSchema.Type` and calls
`TaskPlans.replace`, which checks the revision again when a prepared invocation
runs. Preparation cannot authorize overwriting a later revision. Keep save and
publish synchronous in the existing commit section: a failed save leaves the
previous plan visible. The legacy `update(unknown)` adapter uses the same typed
replacement method without decoding again inside that implementation.

The [command schemas](../src/command-tool-schema.ts) keep executable/argv rules
distinct from stdin rules. Executables reject empty text, an initial dash and
NUL; argument arrays reject NUL but preserve empty, whitespace and option-like
strings. Stdin preserves NUL, whitespace, Unicode and shell-looking text. Never
trim, interpolate or join argv into a shell command during decoding.

Measure stdin with the same UTF-8 byte rule as the command service. The custom
filter adapts the vendored `makeFilter` examples; a string length check would
apply a different limit to multibyte text:

```ts
const Input = Schema.String.check(Schema.makeFilter(
  text => Buffer.byteLength(text, "utf8") <= 65_536,
  { message: "Command input is limited to 65536 bytes per write." }
))
```

Missing/undefined stdin defaults to `""` and is valid only with `eof: true`.
Attach the missing-input/EOF failure to `["input"]` using a struct filter.
Boolean flags reject null; timeout/wait options use nullish numeric defaults.
Run/shell timeout defaults honor the configured value, while background start
keeps its independent 120-second default. Wait permits zero; its default is zero.
Command IDs remain strings with session-state lookup after decoding. Job
existence, pipe state and concurrent writes belong to `CommandTools`; retain its
size/EOF guards for direct callers without parsing a registered payload twice.

The [command registry](../src/command-tool-registry.ts) requires both read and
shell capabilities for command status and listing. All seven command entries require
shell authorization and are installed only when enabled, preserving discovery
and disabled-tool errors. Enabled command-read arguments prepare with the other
parallel reads before I/O; unknown job IDs remain individual runtime failures.
Keep native process supervision and background lifetimes in the existing
service until their separate Effect migration.

The [worker schemas](../src/subagent-tool-schema.ts) adapt the vendored
`isPattern`, `isMaxLength` and custom-filter examples. Keep the original name
regex and measure the 12,000-character task bound on raw UTF-16 text. Check
nonblank text with `trim()` without transforming the task: decoding preserves
its whitespace, Unicode and literal NUL. Encoding also retains that raw text.
Worker IDs are string inputs followed by a session-state lookup, not synthetic
IDs fabricated by a default. Capacity, closure and model/tool acquisition stay
in the typed `spawnTask` method so a prepared invocation checks current state.
The legacy `spawn/status/stop` adapters decode unknown input and call typed
methods; registry handlers use those methods without parsing the payload twice.

The [MCP tool schemas](../src/integration-tool-schema.ts) validate only the local
envelope. Use `Record(String, Unknown)` for the remote `arguments` object and
retain every JSON key and nested value, including `constructor` and an own
`__proto__` key. Do not substitute `Struct({})`, strip undocumented remote fields,
or translate discovered native JSON Schemas during this boundary migration.
The codec and frozen SDK-request tests cover payload preservation independently
of remote discovery and execution.

The MCP call's `beforeDecode` hook checks the configured server and exact tool
allowlist before decoding the remaining payload. Partial field decoders must
report the calling operation's boundary and omit rejected input. Server lookup
uses own keys; `"*"` grants only that literal tool name. This hook is synchronous
and never resolves credentials or acquires a client. Full envelope validation
also finishes before acquisition. The typed `callTool` method rechecks permission
when a prepared invocation runs. Retain SDK request shapes, pagination, caps,
redaction and connect/call deadlines in the existing service.

The [worker registry](../src/subagent-tool-registry.ts) and
[MCP registry](../src/integration-tool-registry.ts) require their corresponding
capability; listing/status/discovery also require read capability. Install these
groups only when their services are enabled. Keep worker restrictions and the
parallel-read allowlist explicit: registration does not authorize external
actions or delegation, and these groups do not become batch-readable merely
because some operations inspect state.

## Bounded batch envelopes

Adapt the vendored `Literals`, `Array` and `Record` examples for a batch of
unknown tool payloads. This shortened example uses two allowed names; the
[production batch schema](../src/parallel-tools.ts) defines the full policy.

```ts
import * as Schema from "effect/Schema"

const ReadName = Schema.Literals(["get_plan", "fetch_url"])
const ReadCall = Schema.Struct({
  tool: ReadName,
  arguments: Schema.Record(Schema.String, Schema.Unknown)
})
const Batch = Schema.Struct({
  calls: Schema.Array(ReadCall).check(Schema.isBetweenLength(1, 8))
})
type BatchArguments = typeof Batch.Type
const decodeBatch = Schema.decodeUnknownSync(Batch, {
  reportInput: false,
  onExcessProperty: "ignore"
})
const args: BatchArguments = decodeBatch({
  calls: [{ tool: "get_plan", arguments: {} }]
})
```

Use the literal schema's `literals` for the runtime set so names have one source
of truth. Keep the batch policy explicit; a registered tool's read capability
does not automatically authorize batching it. This excludes writes, command
execution, worker/MCP operations and recursion. Arrays infer readonly element
types and bounds apply to collection length, without a duplicate call interface.

Decode the complete envelope before preparing any nested call, then prepare all
nested schemas before returning the batch invocation. Preparation must not start
I/O or emit nested-call telemetry. Invocation forwards the same cancellation
signal, emits telemetry when each call starts, and preserves input-order results
even when calls finish out of order. Runtime errors remain per-call results;
interruption escapes the batch. Preserve the existing UTF-8 cap and error text.

Ignore legacy envelope/call extras, but retain every key inside `arguments` until
the nested tool's schema applies its own policy. Reject sparse arrays, malformed
call objects and invalid argument objects before execution. Disabled command
reads retain their legacy per-call errors; enabled command reads must validate
their argument schemas during preparation. Do not defer arbitrary missing
registrations or schema failures into successful batch preparation.

## Errors and domain models

Prefer typed failures inside Effect workflows. Adapted from `10_schema-basics.ts`:

```ts
import { Effect, Schema } from "effect"

class User extends Schema.Class<User>("victral/User")({
  id: Schema.Int,
  name: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"])
}) {}

class InvalidUserPayload extends Schema.TaggedError<InvalidUserPayload>()(
  "InvalidUserPayload",
  { message: Schema.String }
) {}

const decodeUser = Schema.decodeUnknownEffect(User)
const parseUserPayload = Effect.fn("parseUserPayload")((input: unknown) =>
  decodeUser(input).pipe(
    Effect.mapError((error) => new InvalidUserPayload({ message: error.message }))
  )
)
```

When synchronous code should inspect failure without throwing, adapt the
`SchemaError` tests:

```ts
import { Result, Schema } from "effect"

const Profile = Schema.Struct({ profile: Schema.Struct({ email: Schema.String }) })
const result = Schema.decodeUnknownResult(Profile)({ profile: { email: null } })
if (Result.isFailure(result)) {
  const error = result.failure
  console.error(error.message) // includes the profile/email path
} else {
  const profile = result.success
  // profile is validated and typed.
}
```

`Schema.SchemaError` carries structured issues and supports formatted messages
and `toJSON()`. Preserve useful paths when mapping it to an application error,
without logging secrets or complete sensitive payloads. Result adapters return
schema mismatches as failures; defects and non-schema failures can still throw.
Keep `reportInput: false` at credential/configuration boundaries. Enabling input
reporting can put original values into issues and formatted messages. Schema
annotations and custom filter messages must not interpolate private input.

## Typed external I/O failures

[HTTP](../src/core/http.ts) and [MCP](../src/core/mcp.ts) follow the vendored
[`TaggedError` tests](../repos/effect/packages/effect/test/Schema/Schema.test.ts)
and [Schema basics](../repos/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts).
Use `Schema.Literals` for a closed set of failure reasons and `Schema.Defect()`
for a diagnostic cause whose native shape is not part of the wire contract:

```ts
import * as Schema from 'effect/Schema';

class HttpFailure extends Schema.TaggedError<HttpFailure>()('HttpFailure', {
  reason: Schema.Literals(['request', 'body', 'limit', 'response']),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
```

This is adapted from Victral's transport boundary. Set `message` to safe,
application-owned text; MCP's compatibility adapter instead retains its existing
explicit redaction/capping before exposing a server diagnostic. Keep native errors
in `cause`, use existing `TimeoutError` for deadlines, and preserve interruption
as an Effect interruption. Do not serialize diagnostic failures into chat records
or replace cancellation with a successful empty response.

Native MCP tool input schemas remain opaque SDK payloads in this migration.
Schema validates the call envelope and exact access rules; it does not translate
or reinterpret the server's JSON Schema. See the [I/O ownership patterns](effect-runtime.md#http-browsing-and-mcp-services)
for scoped decoding/consumption and cleanup details.

## Avoid

- Type assertions or unchecked `JSON.parse` results standing in for validation.
- Copying v3 APIs such as `Schema.transform` or `Schema.optionalWith` into this
  v4 reference pattern without checking the installed package's API.
- Using `Schema.toType(codec)` when you still need its wire-format decoding;
  that projection removes the encoding transformation.
- Accepting `undefined`, `null`, excess keys, or non-finite numbers accidentally.
- Swallowing decode failures and continuing with fabricated successful values.
- Building schemas or parsers on every request, or using sync adapters for
  effectful transformations.
- Adding experimental JIT/AOT compilation before measurements justify it.
- Import aliases, workspace links, or dependency entries pointing at `repos/`.

For actual Schema implementation changes, test valid and invalid boundary input,
optional/nullable and excess-key cases, and codec round trips. Keep Victral's
checks in `test/`; the vendored Effect tests are reference material, not part
of this application's test suite.
