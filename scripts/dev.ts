import { watch } from 'node:fs';
import path from 'node:path';
import { buildUi } from './build-ui.js';

const root = path.resolve(import.meta.dir, '..');
await buildUi();
const launch = () => Bun.spawn([process.execPath, path.join(root, 'src/cli.ts'), ...process.argv.slice(2)], {
  cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
let child = launch();
let stopping = false, restart = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending = Promise.resolve();
const watcher = watch(path.join(root, 'src'), (_event, filename) => {
  if (!filename || !/\.(?:btsx|ts|js)$/.test(filename)) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    pending = pending.then(async () => {
      await buildUi();
      if (!stopping) { restart = true; child.kill(); }
    }).catch(error => { console.error(error); });
  }, 100);
});
const stop = () => { stopping = true; watcher.close(); clearTimeout(timer); child.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (;;) {
  const code = await child.exited;
  await pending;
  if (stopping || !restart) { process.exitCode = stopping ? 0 : code; break; }
  restart = false;
  child = launch();
}
stop();
process.off('SIGINT', stop);
process.off('SIGTERM', stop);
