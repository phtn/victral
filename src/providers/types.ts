import type { Message, MessageKind, ToolDefinition } from '../types.js';

export type NativeBlock = { type: string; [key: string]: unknown };
export type ProviderPurpose = 'agent' | 'compactor' | 'subagent';
export interface ProviderResult { message: Message; finish_reason?: string; usage?: Record<string, unknown> }
export interface RequestOptions { tools?: ToolDefinition[]; signal?: AbortSignal; stream?: boolean; maxTokens?: number }
export interface StreamOptions extends RequestOptions {
  onText?: (text: string) => void;
  onThought?: (text: string) => void;
  onEntry?: (kind: MessageKind, text: string) => unknown;
}
export interface UsageRecord {
  purpose: ProviderPurpose; model: string; usage?: Record<string, unknown>; finish_reason?: string;
  request_id?: string; status?: 'completed' | 'canceled' | 'error'; latency_ms?: number; ttft_ms?: number; error_type?: string;
}
export interface ProviderOptions {
  apiKey?: string; model?: string; usage?: (record: UsageRecord) => void;
  fetchImpl?: typeof fetch; purpose?: ProviderPurpose; webSearch?: boolean;
  instrument?: boolean;
}
