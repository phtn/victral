import * as Schema from 'effect/Schema';
import type { NativeBlock } from './types.js';

const optional = Schema.optional;
export const Native = Schema.Struct({ type: Schema.String });
export const Usage = Schema.Record(Schema.String, Schema.Unknown);
const Citation = Schema.Struct({ url: optional(Schema.String), title: optional(Schema.Unknown),
  url_citation: optional(Schema.Struct({ url: optional(Schema.String), title: optional(Schema.Unknown) })) });
const Citations = { annotations: optional(Schema.Array(Citation)), citations: optional(Schema.Array(Citation)) };
const CitationArrays = Schema.Struct(Citations);
export const MetaText = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String, ...Citations });
export const MetaThinking = Schema.Struct({ type: Schema.Literal('thinking'), thinking: Schema.String, signature: optional(Schema.String) });
export const MetaTool = Schema.Struct({ type: Schema.Literals(['tool_use', 'server_tool_use']), id: Schema.String, name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown) });
export const OpenaiMessage = Schema.Struct({ type: Schema.Literal('message'), content: optional(Schema.Array(Native)) });
export const OpenaiText = Schema.Struct({ type: Schema.Literal('output_text'), text: optional(Schema.String), ...Citations });
export const OpenaiRefusal = Schema.Struct({ type: Schema.Literal('refusal'), refusal: optional(Schema.String), ...Citations });
export const OpenaiTool = Schema.Struct({ type: Schema.Literal('function_call'), call_id: Schema.String, name: Schema.String, arguments: Schema.String });
export const OpenaiSearch = Schema.Struct({ type: Schema.Literal('web_search_call'), action: optional(Usage) });
const ErrorDetail = Schema.Struct({ message: optional(Schema.String) });
export const MetaResponse = Schema.Struct({ content: Schema.Array(Native), stop_reason: optional(Schema.NullOr(Schema.String)), usage: optional(Usage) });
export const OpenaiResponse = Schema.Struct({ status: optional(Schema.String), output: Schema.Array(Native), usage: optional(Usage),
  error: optional(Schema.NullOr(ErrorDetail)), incomplete_details: optional(Schema.NullOr(Schema.Struct({ reason: optional(Schema.String) }))) });
export const SignatureState = Schema.Struct({ signature: optional(Schema.String) });
export const CitationState = Schema.Struct({ citations: optional(Schema.Array(Schema.Unknown)) });
export const OpenaiState = Schema.Struct({ status: optional(Schema.String), error: optional(Schema.NullOr(ErrorDetail)) });
export const MetaStart = Schema.Struct({ message: Schema.Struct({ usage: optional(Usage) }) });
export const MetaBlockStart = Schema.Struct({ index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), content_block: Native });
export const BlockIndex = Schema.Struct({ index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) });
export const MetaBlockDelta = Schema.Struct({ index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), delta: Native });
export const MetaMessageDelta = Schema.Struct({ delta: Schema.Struct({ stop_reason: optional(Schema.NullOr(Schema.String)) }), usage: optional(Usage) });
export const MetaError = Schema.Struct({ error: optional(ErrorDetail) });
export const OpenaiDelta = Schema.Struct({ delta: Schema.String });
export const OpenaiItemAdded = Schema.Struct({ item: Native });
export const OpenaiItemDone = Schema.Struct({ output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), item: Native });
export const OpenaiTerminal = Schema.Struct({ response: Schema.Unknown });
export const OpenaiError = Schema.Struct({ response: optional(Schema.Struct({ error: optional(ErrorDetail) })), message: optional(Schema.String) });
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export const TextDelta = Schema.Struct({ text: Schema.String });
export const ThinkingDelta = Schema.Struct({ thinking: Schema.String });
export const SignatureDelta = Schema.Struct({ signature: Schema.String });
export const InputDelta = Schema.Struct({ partial_json: Schema.String });
export const CitationDelta = Schema.Struct({ citation: optional(Citation) });

// These schemas check consumed fields without projecting away native extension
// keys. No transformations or defaults are applied to opaque replay payloads.
const parsers = new WeakMap<Schema.Top, (input: unknown) => unknown>();
export const checkedWire = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, input: unknown): S['Type'] =>
  checkedRaw(schema, input);
function checkedRaw<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, input: unknown): S['Type'] {
  let parse = parsers.get(schema);
  if (!parse) { parse = Schema.decodeUnknownSync(schema, { reportInput: false }); parsers.set(schema, parse); }
  parse(input);
  // All schemas in this module are checks with no defaults or transformations.
  // Keep the validated original instead of a projected clone for exact replay.
  return input as S['Type'];
}

export function metaBlock(input: unknown): NativeBlock {
  const block = checkedWire(Native, input);
  if (block.type === 'text') checkedWire(MetaText, input);
  if (block.type === 'thinking') checkedWire(MetaThinking, input);
  if (block.type === 'tool_use' || block.type === 'server_tool_use') checkedWire(MetaTool, input);
  // citationFooter consumes citation arrays even on native extension blocks.
  checkedWire(CitationArrays, input);
  return block;
}
export function openaiBlock(input: unknown): NativeBlock {
  const block = checkedWire(Native, input);
  if (block.type === 'output_text') checkedWire(OpenaiText, input);
  if (block.type === 'refusal') checkedWire(OpenaiRefusal, input);
  checkedWire(CitationArrays, input);
  return block;
}
export function openaiItem(input: unknown): NativeBlock {
  const item = checkedWire(Native, input);
  if (item.type === 'function_call') checkedWire(OpenaiTool, input);
  if (item.type === 'web_search_call') checkedWire(OpenaiSearch, input);
  if (item.type === 'message') for (const block of checkedWire(OpenaiMessage, input).content ?? []) openaiBlock(block);
  return item;
}
