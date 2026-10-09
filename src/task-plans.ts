export interface PlanStep { step: string; status: 'pending' | 'in_progress' | 'completed' }
export interface TaskPlan { project: string; title: string; steps: PlanStep[]; revision: number; updated_at: string }
export interface PlanStore { load(): unknown[]; save(plan: TaskPlan): void }

function steps(value: unknown): PlanStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new Error('steps must contain between 1 and 50 plan steps.');
  let active = 0;
  const parsed = value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.step !== 'string' || !item.step.trim() || item.step.length > 500) throw new Error('Each plan step needs nonempty text of at most 500 characters.');
    if (!['pending', 'in_progress', 'completed'].includes(item.status)) throw new Error('Plan status must be pending, in_progress, or completed.');
    if (item.status === 'in_progress') active++;
    return { step: item.step.trim(), status: item.status } as PlanStep;
  });
  if (active > 1) throw new Error('Only one plan step may be in_progress.');
  return parsed;
}

export class TaskPlans {
  private current?: TaskPlan;
  constructor(private project: string, private store?: PlanStore) {
    for (const value of store?.load() ?? []) {
      if (!value || typeof value !== 'object' || (value as TaskPlan).project !== project) continue;
      const plan = value as TaskPlan;
      if (typeof plan.title !== 'string' || !plan.title.trim() || plan.title.length > 200 || !Number.isSafeInteger(plan.revision) || plan.revision < 1 || typeof plan.updated_at !== 'string' || !Number.isFinite(Date.parse(plan.updated_at))) throw new Error('Invalid saved task plan. Restore the plans log from backup.');
      const parsed = steps(plan.steps);
      if (plan.revision <= (this.current?.revision ?? 0)) throw new Error('Saved task plan revisions must increase.');
      this.current = { ...plan, steps: parsed };
    }
  }
  get(): string { return this.current ? JSON.stringify(this.current, null, 2) : 'No task plan. Use update_plan with expected_revision: 0 to create one.'; }
  context(): string { return this.current ? `Current task plan (agent-authored state; use get_plan and update_plan):\n${this.get()}` : ''; }
  update(args: Record<string, unknown>): string {
    const revision = this.current?.revision ?? 0;
    if (!Number.isSafeInteger(args.expected_revision) || (args.expected_revision as number) < 0) throw new Error('expected_revision must be a nonnegative integer.');
    if (args.expected_revision !== revision) throw new Error(`Plan revision changed: expected ${args.expected_revision}, current ${revision}. Read get_plan before updating.`);
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200) throw new Error('title must contain between 1 and 200 characters.');
    const next: TaskPlan = { project: this.project, title: args.title.trim(), steps: steps(args.steps), revision: revision + 1, updated_at: new Date().toISOString() };
    // Publish state only after the durable write succeeds.
    this.store?.save(next);
    this.current = next;
    return this.get();
  }
}
