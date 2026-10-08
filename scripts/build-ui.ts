import fs from 'node:fs/promises';
import path from 'node:path';
import { compileBeast } from 'beast-tsrx';
import { createOctaneCompiler } from 'octane/compiler/bundler';
import { inkRenderers } from '@octanejs/ink/config';
import { preserveInk8Input } from './ink-input-compat.js';

const root = path.resolve(import.meta.dir, '..');
export async function buildUi(): Promise<void> {
  const source = path.join(root, 'src/workspace.ink.btsx');
  const generated = path.join(root, 'src/workspace.ink.tsrx');
  const code = compileBeast(await fs.readFile(source, 'utf8'), { filename: source, componentName: 'Workspace' });
  // Preserve mtimes for unchanged generated source while developing.
  if (await fs.readFile(generated, 'utf8').catch(() => '') !== code) await fs.writeFile(generated, code);

  const compiler = createOctaneCompiler({ root, renderers: inkRenderers, hmr: false, dev: false });
  const result = await Bun.build({
    entrypoints: [path.join(root, 'scripts/ui-entry.ts')],
    target: 'bun',
    outdir: path.join(root, '.generated'),
    naming: 'tui.js',
    sourcemap: 'linked',
    plugins: [{
      name: 'octane-ink',
      setup(build) {
        build.onLoad({ filter: /\.(?:tsrx|tsx|ts|js)$/ }, async ({ path: filename }) => {
          let source = await fs.readFile(filename, 'utf8');
          if (filename.endsWith('/@octanejs/ink/src/hooks/use-input.ts')) source = preserveInk8Input(source);
          const transformed = compiler.transform(source, filename);
          if (!transformed) return;
          return { contents: transformed.code, loader: 'ts' };
        });
      },
    }],
  });
  if (!result.success) throw new AggregateError(result.logs, 'Terminal UI compilation failed');
  await fs.writeFile(path.join(root, '.generated/tui.d.ts'), "export { default as Workspace } from '../src/workspace.ink.tsrx';\nexport { render } from '@octanejs/ink';\n");
}

if (import.meta.main) await buildUi();
