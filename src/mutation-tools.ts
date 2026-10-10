import fs from 'node:fs/promises';
import path from 'node:path';
import { applyProjectPatch } from './apply-patch.js';
import { schemaTool } from './tool-registry.js';
import { WriteFileSchema, EditFileSchema, ApplyPatchSchema } from './mutation-tool-schema.js';
import { UpdatePlanSchema } from './task-plan-schema.js';
import type { TaskPlans } from './task-plans.js';

export function mutationTools(options: { resolveFile: (relative: string) => Promise<string>; plans: TaskPlans }) {
  const { resolveFile, plans } = options;
  async function write(filename: string, content: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content, 'utf8');
  }
  return [
    schemaTool({ name: 'write_file', schema: WriteFileSchema, capabilities: ['write'], async execute(args, signal) {
      const filename = await resolveFile(args.path);
      await write(filename, args.content, signal);
      return `Wrote ${args.path}.`;
    } }),
    schemaTool({ name: 'edit_file', schema: EditFileSchema, capabilities: ['write'], async execute(args, signal) {
      const filename = await resolveFile(args.path), current = await fs.readFile(filename, 'utf8');
      const first = current.indexOf(args.old_text);
      if (first < 0) throw new Error('old_text was not found; read the file again.');
      if (current.indexOf(args.old_text, first + 1) >= 0) throw new Error('old_text is ambiguous; include more context.');
      const content = current.slice(0, first) + args.new_text + current.slice(first + args.old_text.length);
      await write(filename, content, signal);
      return `Edited ${args.path}.`;
    } }),
    schemaTool({ name: 'apply_patch', schema: ApplyPatchSchema, capabilities: ['write'], execute: (args, signal) => applyProjectPatch(args.patch, resolveFile, signal) }),
    schemaTool({ name: 'update_plan', schema: UpdatePlanSchema, capabilities: ['write'],
      beforeDecode: value => plans.checkUpdateRevision(value), execute: args => plans.replace(args),
    }),
  ];
}
