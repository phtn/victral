export type MessageKind = 'user' | 'talk' | 'tool' | 'echo' | 'note';
export interface ContentBlock { type: string; text?: string; [key: string]: unknown }
export interface ToolCall { id: string; function: { name: string; arguments: string } }
export interface Message {
  role: string; content: string | ContentBlock[]; tool_calls?: ToolCall[];
  tool_call_id?: string; [key: string]: unknown;
}
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: {
    type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[];
  } };
}
export interface AgentTools {
  definitions: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}
export interface MemoryPort {
  append(kind: MessageKind, text: string): unknown;
  settle(signal?: AbortSignal): Promise<boolean>;
  render(): string;
  zoom(id: number, n: number): string;
  date(id: number): string;
}
export interface ModelPort {
  model: string;
  stream(messages: Message[], options: {
    tools: ToolDefinition[]; signal: AbortSignal;
    onText(text: string): void; onThought(text: string): void;
    onEntry(kind: MessageKind, text: string): unknown;
  }): Promise<{ message: Message; finish_reason?: string }>;
}
export interface TurnRecord {
  status: 'completed' | 'canceled' | 'error'; model?: string;
  duration_ms: number; settle_ms: number; tool_calls: number; retrievals: number;
}
export interface ToolActivity { name: string; status: 'running' | 'completed' | 'error'; duration_ms?: number }
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
