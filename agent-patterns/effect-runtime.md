# Effect runtime patterns for Victral

The initial dependency is pinned to `effect@4.0.2`. Consult the read-only v4
checkout under `repos/effect`, then compile against the installed package.
Import from `effect` or its public modules, never from the checkout. Prefer
public module imports such as `effect/Schema` in production boundaries to limit
cold module loading with the application's external-package Bun build.

## Services and ownership

Follow the vendored [service example](../repos/effect/ai-docs/src/01_effect/03_services/01_service.ts):
extend `Context.Service` with a package-qualified identifier, implement traced
methods with `Effect.fn`, and provide implementations through `Layer`. Keep
pure helpers as ordinary functions. `src/core/legacy-ports.ts` is the initial
compiled application example; its tests provide a fake layer with existing
`ModelPort` and `AgentTools` implementations.

`LegacyPorts.layer` adapts methods only. The legacy Session/Runner still owns
port cleanup, timers, listeners and background jobs. A layer must not also
invoke legacy `close()` unless resource ownership has explicitly moved to it.
Do not add a disposable runtime per request. Step 3 will introduce one session
`ManagedRuntime`, following the vendored
[integration example](../repos/effect/ai-docs/src/04_integration/10_managed-runtime.ts).

## Promise and AbortSignal boundaries

`fromAbortablePromise` adapts a possibly failing Promise through
`Effect.tryPromise({ try, catch })`. It is lazy and catches both synchronous
throws and Promise rejections. Always pass its supplied AbortSignal into the
actual operation. An interrupted waiting fiber cannot stop an SDK, stream or
process that ignores cancellation. Resource-owning adapters also need scoped
finalizers; `tryPromise` does not acquire ownership or wait for arbitrary
legacy cleanup to finish.

`toLegacyPromise` runs already-provided effects for Promise/UI consumers. It
checks a pre-aborted signal before executing any side effects, and uses
`runPromiseExit` so structured causes survive. It rejects only after Effect
scope finalizers finish. When a session runtime exists, move this execution to
that runtime's boundary instead of continuing to use a separate runner.

The adapters preserve callbacks, result objects, provider definitions, selected
models and call counts. They add no retries, deadlines, fallback models or
background fibers. Translate caller AbortSignals at the execution boundary;
use Effect's signal inside operations.

## Failure, interruption and defects

`src/core/errors.ts` defines `ValidationError`, `IOError`, `TimeoutError`,
`ProtocolError`, `ToolAccessDenied` and `ToolExecutionError`. Use tagged errors
for expected outcomes that callers need to distinguish. A validation error
retains its Schema cause and an application-owned safe message. The temporary
legacy model/tool adapters retain unclassified Promise failures as `IOError`
or `ToolExecutionError`; do not classify legacy failures by matching display
strings. Add domain-specific failures when the implementations migrate.

- **Failure** is an expected value in Effect's typed error channel. Handle it
  with typed handlers and domain policy.
- **Interruption** ends a workflow's lifetime. Preserve it through error
  handlers; do not convert it into success, an empty result or a retry.
- **Defect** signals an unexpected implementation failure. Keep it distinct
  from recoverable failures. A throwing error-mapper itself creates a defect.

The public adapter rejects with `EffectAdapterError`: `kind` distinguishes these
outcomes, interruption uses the `AbortError` name, and `cause` retains the full
Effect Cause. Combined cleanup/original failures remain present. Only its safe
message should reach UI consumers; never stringify diagnostic causes, private
provider errors or configuration payloads into public output. Operation names
and `ValidationError.message` must be application-owned text. Use constant
messages for unknown failures and defects.

Refer to [Effect.tryPromise](../repos/effect/packages/effect/src/Effect.ts),
[Cause](../repos/effect/packages/effect/src/Cause.ts), and
[scoped acquisition](../repos/effect/ai-docs/src/01_effect/05_resources/10_acquire-release.ts).
Keep Bun tests until a real controllable-clock/fiber testing need arises.
