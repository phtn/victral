import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import { ArgumentsObjectSchema, defaultBooleanArgument, defaultIntegerArgument, integerArgument, textArgument } from './tool-argument-schema.js';

const Program = textArgument('program').check(Schema.makeFilter(
  value => !!value && !value.startsWith('-') && !value.includes('\0'), { message: 'Expected a CLI program name.' },
));
const argvMessage = 'args must be an array of strings.';
const Argument = Schema.String.check(Schema.makeFilter(value => !value.includes('\0'), { message: argvMessage }))
  .annotate({ identifier: argvMessage });
const Arguments = Schema.Array(Argument).annotate({ identifier: argvMessage }).annotateKey({ messageMissingKey: argvMessage });

// Preserve literal argv, including empty/whitespace text and option-like args.
// Only the executable excludes an initial dash; all argv entries exclude NUL.
export function runCommandSchema(timeoutMs: number) {
  return Schema.Struct({ program: Program, args: Arguments, timeout_ms: defaultIntegerArgument('timeout_ms', timeoutMs, 120_000) });
}
export function shellSchema(timeoutMs: number) {
  return Schema.Struct({ command: textArgument('command'), timeout_ms: defaultIntegerArgument('timeout_ms', timeoutMs, 120_000) });
}
export const StartCommandSchema = Schema.Struct({ program: Program, args: Arguments,
  timeout_ms: defaultIntegerArgument('timeout_ms', 120_000, 600_000), interactive: defaultBooleanArgument('interactive', false),
});

const Wait = integerArgument('wait_ms', 0, 10_000);
const DefaultWait = Schema.NullOr(Wait).pipe(
  Schema.decodeTo(Wait, SchemaTransformation.transform({ decode: value => value ?? 0, encode: value => value })),
  Schema.withDecodingDefault(Effect.succeed(0)),
);
// IDs are session-state lookups, not a syntactic command-N pattern. Retain the
// original string so unknown IDs still receive the service's recovery message.
export const CommandStatusSchema = Schema.Struct({ command_id: textArgument('command_id'), wait_ms: DefaultWait });
export const StopCommandSchema = Schema.Struct({ command_id: textArgument('command_id') });
export const ListCommandsSchema = ArgumentsObjectSchema;

const Input = textArgument('input').check(Schema.makeFilter(value => Buffer.byteLength(value, 'utf8') <= 65_536,
  { message: 'Command input is limited to 65536 bytes per write.' })).pipe(Schema.withDecodingDefault(Effect.succeed('')));
export const WriteCommandInputSchema = Schema.Struct({ command_id: textArgument('command_id'), input: Input,
  eof: defaultBooleanArgument('eof', false),
}).check(Schema.makeFilter(args => args.input || args.eof ? undefined : { path: ['input'], issue: 'Provide input or set eof: true.' }));
