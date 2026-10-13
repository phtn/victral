// No raw prompts, arguments, output or credentials belong in workflow events.
export interface WorkflowEvent {
  readonly operationId: string;
  readonly kind: 'turn' | 'model' | 'tool' | 'worker' | 'evaluation';
  readonly status: 'processing' | 'completed' | 'failed' | 'canceled' | 'retry';
}
export type WorkflowObserver = (event: WorkflowEvent, signal?: AbortSignal) => void;
