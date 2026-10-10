import * as Schema from 'effect/Schema';

// Causes are internal diagnostics. Public messages must never interpolate them.
export class ValidationError extends Schema.TaggedError<ValidationError>()('ValidationError', {
  boundary: Schema.String, message: Schema.String, cause: Schema.Defect(),
}) {}
export class IOError extends Schema.TaggedError<IOError>()('IOError', {
  operation: Schema.String, cause: Schema.Defect(),
}) {}
export class TimeoutError extends Schema.TaggedError<TimeoutError>()('TimeoutError', {
  operation: Schema.String, cause: Schema.Defect(),
}) {}
export class ProtocolError extends Schema.TaggedError<ProtocolError>()('ProtocolError', {
  operation: Schema.String, cause: Schema.Defect(),
}) {}
export class ToolAccessDenied extends Schema.TaggedError<ToolAccessDenied>()('ToolAccessDenied', {
  tool: Schema.String,
}) {}
export class ToolExecutionError extends Schema.TaggedError<ToolExecutionError>()('ToolExecutionError', {
  tool: Schema.String, cause: Schema.Defect(),
}) {}

export type AppError = ValidationError | IOError | TimeoutError | ProtocolError | ToolAccessDenied | ToolExecutionError;

// These operation names and validation messages must be application-owned text.
export function publicFailureMessage(error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  if (error instanceof IOError) return `${error.operation} failed.`;
  if (error instanceof TimeoutError) return `${error.operation} timed out.`;
  if (error instanceof ProtocolError) return `${error.operation} returned an invalid response.`;
  if (error instanceof ToolAccessDenied) return 'This tool is not permitted.';
  if (error instanceof ToolExecutionError) return 'Tool execution failed.';
  return 'The operation failed.';
}
