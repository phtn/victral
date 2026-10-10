import { parsePlanUpdateRevision, parsePlanUpdate, parseSavedTaskPlan, type TaskPlan, type PlanUpdate } from './task-plan-schema.js';
export type { PlanStep, TaskPlan } from './task-plan-schema.js';
export interface PlanStore { load(): unknown[]; save(plan: TaskPlan): void }

export class TaskPlans {
  private current?: TaskPlan;
  constructor(private project: string, private store?: PlanStore) {
    for (const value of store?.load() ?? []) {
      if (!value || typeof value !== 'object' || !('project' in value) || value.project !== project) continue;
      const plan = parseSavedTaskPlan(value);
      if (plan.revision <= (this.current?.revision ?? 0)) throw new Error('Saved task plan revisions must increase.');
      // Overwrite every known field with validated data while keeping the
      // original key order in get()/context(), including legacy metadata.
      this.current = { ...value, ...plan };
    }
  }
  get(): string { return this.current ? JSON.stringify(this.current, null, 2) : 'No task plan. Use update_plan with expected_revision: 0 to create one.'; }
  context(): string { return this.current ? `Current task plan (agent-authored state; use get_plan and update_plan):\n${this.get()}` : ''; }
  private checkRevision(expected: number): void {
    const revision = this.current?.revision ?? 0;
    if (expected !== revision) throw new Error(`Plan revision changed: expected ${expected}, current ${revision}. Read get_plan before updating.`);
  }
  checkUpdateRevision(value: unknown): void { this.checkRevision(parsePlanUpdateRevision(value)); }
  update(args: unknown): string {
    this.checkUpdateRevision(args);
    return this.replace(parsePlanUpdate(args));
  }
  replace(input: PlanUpdate): string {
    // Prepared registry calls can outlive the current revision. Recheck at the
    // synchronous commit boundary before saving or publishing any state.
    this.checkRevision(input.expected_revision);
    const revision = this.current?.revision ?? 0;
    if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Task plan revision cannot exceed Number.MAX_SAFE_INTEGER.');
    const next: TaskPlan = { project: this.project, title: input.title, steps: input.steps, revision: revision + 1, updated_at: new Date().toISOString() };
    // Publish state only after the durable write succeeds.
    this.store?.save(next);
    this.current = next;
    return this.get();
  }
}
