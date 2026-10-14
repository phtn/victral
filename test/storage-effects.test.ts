import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import { Storage, day } from '../src/storage.js';

const stores: Storage[] = [], directories: string[] = [], restore: (() => void)[] = [];
afterEach(async () => {
  for (const undo of restore.splice(0).reverse()) undo();
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-storage-effects-')); directories.push(dir); return dir; }
async function fixture() { const storage = await Storage.open(directory(), () => {}); stores.push(storage); return storage; }

test('legacy records keep unknown metadata and optional missing fields across load and restart', async () => {
  const dir = directory(); fs.mkdirSync(path.join(dir, 'main')); fs.mkdirSync(path.join(dir, 'tree'));
  fs.writeFileSync(path.join(dir, 'main', `${day()}.jsonl`), '{"i":0,"kind":"user","text":"🦓","legacy":{"x":1}}\n');
  fs.writeFileSync(path.join(dir, 'tree', `${day()}.jsonl`), '{"l":0,"i":0,"text":"🦓","size":99,"extension":true}\n');
  const storage = await Storage.open(dir); stores.push(storage);
  expect(storage.root[0]?.legacy).toEqual({ x: 1 }); expect(storage.nodes.get('0:0')?.size).toBe(4);
  expect(storage.nodes.get('0:0')?.extension).toBe(true);
  storage.append('note', 'next'); await storage.close();
  const restarted = await Storage.open(dir); stores.push(restarted); expect(restarted.root).toHaveLength(2);
  expect(restarted.root[0]?.legacy).toEqual({ x: 1 });
});

test('scoped storage acquisition releases its lock on failure and interruption', async () => {
  const dir = directory();
  const failed = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
    yield* Storage.acquire(dir); return yield* Effect.fail('startup');
  })));
  expect(failed._tag).toBe('Failure');
  const again = await Storage.open(dir); await again.close();
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function*() { yield* Storage.acquire(dir); return yield* Effect.never; })));
  await Bun.sleep(0); await Effect.runPromise(Fiber.interrupt(fiber));
  const reopened = await Storage.open(dir); stores.push(reopened);
});

test('stale lock debris is recovered while live lock contention remains visible', async () => {
  const dir = directory();
  const child = Bun.spawn([process.execPath, '-e', "import net from 'node:net'; net.createServer().listen(process.env.VICTRAL_TEST_LOCK, () => process.stdout.write('ready'));"],
    { env: { ...process.env, VICTRAL_TEST_LOCK: path.join(dir, 'lock') }, stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  try { expect((await reader.read()).done).toBe(false); } finally { child.kill(9); await child.exited; reader.releaseLock(); }
  const storage = await Storage.open(dir); stores.push(storage);
  await expect(Storage.open(dir)).rejects.toThrow('already open');
  await storage.close(); const next = await Storage.open(dir); stores.push(next);
});

test('append publishes only after file fsync, close and fresh directory fsync', async () => {
  const storage = await fixture(), order: string[] = [];
  const write = fs.writeSync, sync = fs.fsyncSync, close = fs.closeSync, push = storage.root.push;
  const w = spyOn(fs, 'writeSync').mockImplementation(((...args: Parameters<typeof fs.writeSync>) => { order.push('write'); return write(...args); }) as typeof fs.writeSync);
  const s = spyOn(fs, 'fsyncSync').mockImplementation(fd => { order.push('fsync'); sync(fd); });
  const c = spyOn(fs, 'closeSync').mockImplementation(fd => { order.push('close'); close(fd); });
  const p = spyOn(storage.root, 'push').mockImplementation((...records) => { order.push('publish'); return push.apply(storage.root, records); });
  restore.push(() => { w.mockRestore(); s.mockRestore(); c.mockRestore(); p.mockRestore(); });
  await Effect.runPromise(storage.appendEffect('user', 'durable'));
  expect(order).toEqual(['write', 'fsync', 'close', 'fsync', 'close', 'publish']);
  expect(fs.statSync(path.join(storage.directory, 'main', `${day()}.jsonl`)).mode & 0o777).toBe(0o600);
});

test('short append and failed node fsync leave in-memory state unpublished', async () => {
  const storage = await fixture();
  const short = spyOn(fs, 'writeSync').mockReturnValue(0); restore.push(() => short.mockRestore());
  await expect(Effect.runPromise(storage.appendEffect('user', 'lost'))).rejects.toThrow('Short log write');
  expect(storage.root).toHaveLength(0); short.mockRestore(); storage.append('user', 'source');
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('fsync failure'); }); restore.push(() => sync.mockRestore());
  await expect(Effect.runPromise(storage.saveNodeEffect(0, 0, 'summary'))).rejects.toThrow('fsync failure');
  expect(storage.nodes.has('0:0')).toBe(false);
});

test('view replacement writes and fsyncs its temporary file before rename and directory fsync', async () => {
  const storage = await fixture(); storage.saveView([]);
  const order: string[] = [], write = fs.writeSync, sync = fs.fsyncSync, close = fs.closeSync, rename = fs.renameSync;
  const w = spyOn(fs, 'writeSync').mockImplementation(((...args: Parameters<typeof fs.writeSync>) => { order.push('write'); return write(...args); }) as typeof fs.writeSync);
  const s = spyOn(fs, 'fsyncSync').mockImplementation(fd => { order.push('fsync'); sync(fd); });
  const c = spyOn(fs, 'closeSync').mockImplementation(fd => { order.push('close'); close(fd); });
  const r = spyOn(fs, 'renameSync').mockImplementation((a, b) => { order.push('rename'); rename(a, b); });
  restore.push(() => { w.mockRestore(); s.mockRestore(); c.mockRestore(); r.mockRestore(); });
  await Effect.runPromise(storage.saveViewEffect([[0, 0]], 'view'));
  expect(order).toEqual(['write', 'fsync', 'close', 'rename', 'fsync', 'close']);
  expect(storage.loadView()).toEqual([[0, 0]]);
});

test('failed or short temporary view writes retain the previous atomic view', async () => {
  const storage = await fixture(); storage.saveView([]);
  const short = spyOn(fs, 'writeSync').mockReturnValue(0); restore.push(() => short.mockRestore());
  expect(() => storage.saveView([[0, 0]])).toThrow('Short view write'); expect(storage.loadView()).toEqual([]);
  short.mockRestore(); const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('rename failure'); }); restore.push(() => rename.mockRestore());
  expect(() => storage.saveView([[0, 0]])).toThrow('rename failure'); expect(storage.loadView()).toEqual([]);
});

test('valid JSON with a corrupt message fails visibly and releases the lock for backup repair', async () => {
  const dir = directory(); fs.mkdirSync(path.join(dir, 'main'));
  const file = path.join(dir, 'main', `${day()}.jsonl`); fs.writeFileSync(file, '{"i":0,"kind":"user","text":3}\n');
  await expect(Storage.open(dir)).rejects.toThrow('Invalid message IDs or records');
  fs.writeFileSync(file, '{"i":0,"kind":"user","text":"restored"}\n');
  const restored = await Storage.open(dir); stores.push(restored); expect(restored.root[0]?.text).toBe('restored');
});

test('interruption requested inside fsync cannot separate the durable append from its in-memory publication', async () => {
  const storage = await fixture(), controller = new AbortController(), fsync = fs.fsyncSync;
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => { fsync(fd); controller.abort(); });
  restore.push(() => sync.mockRestore());
  await Effect.runPromiseExit(storage.appendEffect('user', 'committed despite cancellation'), { signal: controller.signal });
  sync.mockRestore(); expect(controller.signal.aborted).toBe(true);
  expect(storage.root).toHaveLength(1); expect(storage.root[0]?.text).toBe('committed despite cancellation');
  await storage.close(); const reopened = await Storage.open(storage.directory); stores.push(reopened);
  expect(reopened.root).toEqual(storage.root);
});
