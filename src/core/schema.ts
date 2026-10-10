import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { ValidationError } from './errors.js';

// Compile once at the boundary. Schema causes stay available for diagnostics;
// public messages include field paths, but never rejected input values.
export function validationDecoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S, boundary: string, onExcessProperty: 'ignore' | 'error' = 'ignore',
): (value: unknown) => S['Type'] {
  const decode = Schema.decodeUnknownResult(schema, { onExcessProperty, reportInput: false });
  return value => {
    const result = decode(value);
    if (Result.isFailure(result)) throw new ValidationError({ boundary,
      message: `${boundary}: ${result.failure.message}`, cause: result.failure });
    return result.success;
  };
}
