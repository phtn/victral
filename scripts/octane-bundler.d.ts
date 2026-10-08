// Octane 0.8 ships the bundler API without declarations. Keep this narrow
// adapter contract aligned with the public options used by our Bun build.
declare module 'octane/compiler/bundler' {
  import type { OctaneRendererConfigOptions } from 'octane/compiler/vite';
  export function createOctaneCompiler(options: {
    root: string;
    renderers: OctaneRendererConfigOptions;
    hmr: boolean;
    dev: boolean;
  }): {
    transform(source: string, filename: string): { code: string } | null;
  };
}
