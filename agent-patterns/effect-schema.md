# Effect Schema patterns for Victral

Use the vendored Effect source as reference material, and import application
code from normal package dependencies. `@repos/` in `AGENTS.md` means the
repository's `repos/` directory; it is not a TypeScript import alias.
Never import from or edit `repos/effect` when implementing application features.

The reference checkout identifies itself as Effect **4.0.3**. These examples
follow its v4 API. Victral does not currently declare an `effect` dependency:
before introducing runtime Schema code, add a compatible normal dependency
and verify examples against that installed version. Do not assume that a v3
package implements these signatures or silently migrate existing validation.

## Reference material

Review these files before writing related code:

- [Schema guide](../repos/effect/packages/effect/SCHEMA.md): constructors,
  optional fields, codecs, transformations, and error handling.
- [Schema implementation](../repos/effect/packages/effect/src/Schema.ts):
  signatures, supported services, and JSDoc examples.
- [Schema runtime tests](../repos/effect/packages/effect/test/schema/Schema.test.ts):
  success, rejection, parse options, round trips, and formatted errors.
- [Schema basics](../repos/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts):
  domain classes, reusable parsers, and typed application errors.
- [SchemaGetter tests](../repos/effect/packages/effect/test/schema/SchemaGetter.test.ts)
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
  errors: "all"
})
```

This adapts excess-property cases from `Schema.test.ts`. Do not assume unknown
keys are rejected by default. Choose ignore or error behavior deliberately
and test it against the external contract.

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
