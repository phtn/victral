import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SchemaTransformation from 'effect/SchemaTransformation';

export function textArgument(name: string, message = `Expected ${name} to be text.`) {
  return Schema.String.annotate({ identifier: message }).annotateKey({ messageMissingKey: message });
}
export function integerArgument(name: string, minimum: number, maximum: number,
  message = `${name} must be an integer between ${minimum} and ${maximum}.`,
) {
  return Schema.Number.check(Schema.isInt({ message }), Schema.isBetween({ minimum, maximum }, { message }))
    .annotate({ identifier: message }).annotateKey({ messageMissingKey: message });
}
export function defaultIntegerArgument(name: string, fallback: number, maximum: number, message?: string) {
  const integer = integerArgument(name, 1, maximum, message);
  // Legacy numeric options use ?? defaults, including null, without coercion.
  return Schema.NullOr(integer).pipe(
    Schema.decodeTo(integer, SchemaTransformation.transform({ decode: value => value ?? fallback, encode: value => value })),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );
}
export function defaultBooleanArgument(name: string, fallback: boolean) {
  return Schema.Boolean.annotate({ identifier: `${name} must be boolean.` }).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );
}

// Struct({}) accepts non-null primitives in this Effect version. A Record
// requires an actual arguments object; no-argument handlers ignore its keys.
export const ArgumentsObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
