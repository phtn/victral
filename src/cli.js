#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { Storage } from './storage.js';
import { Memory } from './memory.js';
import { createModel, MODELS } from './models.js';
import { Runner } from './runner.js';
import { projectTools } from './tools.js';
import { MODEL } from './constants.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { values } = parseArgs({ options: {
  project: { type: 'string', default: process.cwd() },
  'chat-dir': { type: 'string', default: path.join(os.homedir(), '.local/share/victral/chat') },
  instructions: { type: 'string' },
  ask: { type: 'string' },
  'allow-shell': { type: 'boolean', default: false },
  model: { type: 'string' },
  'compactor-model': { type: 'string' },
  models: { type: 'boolean' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: npm start -- [--project PATH] [--chat-dir PATH] [--instructions FILE] [--model ID] [--compactor-model ID] [--models] [--ask TEXT] [--allow-shell]\nCommands: /model [ID], /view, /zoom ID N, /date ID, /usage, /backup PATH, /import FILE, /cancel, /exit');
  process.exit(0);
}
if (values.models) { console.log(MODELS.join('\n')); process.exit(0); }
const project = fs.realpathSync(values.project);
const instructionFile = values.instructions ?? path.join(project, 'AGENTS.md');
const instructions = fs.existsSync(instructionFile) ? fs.readFileSync(instructionFile, 'utf8') : '';
if (values.instructions && !fs.existsSync(instructionFile)) throw new Error('The instructions file does not exist.');
let storage, memory, runner, rl, closing = false;
try {
  // Check credentials before acquiring the single-writer lock.
  const agentId = values.model ?? process.env.VICTRAL_MODEL ?? process.env.COHERE_MODEL ?? MODEL;
  const compactorId = values['compactor-model'] ?? process.env.VICTRAL_COMPACTOR_MODEL ?? process.env.COHERE_COMPACTOR_MODEL ?? agentId;
  const agent = createModel(agentId, { usage: record => storage.usage(record) });
  const compactor = createModel(compactorId, { purpose: 'compactor', usage: record => storage.usage(record) });
  storage = await Storage.open(path.resolve(values['chat-dir']));
  memory = new Memory(storage, compactor);
  runner = new Runner(memory, agent, projectTools(memory, project, { allowShell: values['allow-shell'] }), instructions, {
    onText: text => process.stdout.write(text),
    onThought: text => { if (process.stdout.isTTY) process.stdout.write(`\x1b[2m${text}\x1b[0m`); },
    onError: text => console.error(`\n${text}`),
  });
  console.log(`Victral · ${agent.model}\nCompactor: ${compactor.model}\nProject: ${project}\nMemory: ${storage.directory}\n${memory.render()}\n`);
  memory.pump();
  async function close() {
    if (closing) return;
    closing = true; rl?.close();
    await runner.close(); await memory.stop(); await storage.close();
  }
  if (values.ask !== undefined) {
    process.on('SIGINT', () => runner.cancel());
    await runner.submit(values.ask);
    console.log();
    // Finish level-0 summaries before exit. Parent merges may resume next launch.
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    await memory.settle(controller.signal);
    await close();
  } else {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    const prompt = () => { if (!closing) rl.prompt(); };
    rl.on('SIGINT', () => { runner.cancel(); console.log('\nCanceled. Use /exit to close.'); prompt(); });
    process.on('SIGTERM', () => { void close(); });
    rl.on('line', line => {
      if (closing || !line.trim()) { prompt(); return; }
      if (line === '/exit') { void close(); return; }
      if (line === '/cancel') { runner.cancel(); prompt(); return; }
      if (line === '/model') { console.log(`Agent: ${runner.model.model}\nCompactor: ${memory.model.model}\nAvailable: ${MODELS.join(', ')}`); prompt(); return; }
      if (line.startsWith('/model ')) {
        try {
          if (runner.active) throw new Error('Switch models between turns; /cancel ends the current turn.');
          runner.model = createModel(line.slice(7).trim(), { usage: record => storage.usage(record) });
          console.log(`Victral now uses ${runner.model.model}. Saved memory is retained.`);
        } catch (error) { console.error(error.message); }
        prompt(); return;
      }
      if (line === '/view') { console.log(memory.render()); prompt(); return; }
      if (line.startsWith('/zoom ')) { const [, id, n] = line.split(/\s+/); console.log(memory.zoom(Number(id), Number(n))); prompt(); return; }
      if (line.startsWith('/date ')) { console.log(memory.date(Number(line.slice(6)))); prompt(); return; }
      if (line === '/usage') {
        console.log(JSON.stringify(storage.load('usage').slice(-10), null, 2)); prompt(); return;
      }
      if (line.startsWith('/backup ')) {
        try {
          const destination = path.resolve(line.slice(8).trim());
          if (destination === storage.directory || destination.startsWith(storage.directory + path.sep)) throw new Error('Choose a backup path outside the live chat directory.');
          if (fs.existsSync(destination)) throw new Error('Backup destination already exists; choose a new path.');
          fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
          // Synchronous copy runs between event-loop callbacks: no concurrent append.
          for (const sub of ['main', 'tree', 'usage']) fs.cpSync(path.join(storage.directory, sub), path.join(destination, sub), { recursive: true });
          console.log(`Backup saved to ${destination}`);
        } catch (error) { console.error(error.message); }
        prompt(); return;
      }
      if (line.startsWith('/import ')) {
        try {
          if (runner.active) throw new Error('Import history between turns.');
          const contents = fs.readFileSync(path.resolve(line.slice(8).trim()), 'utf8');
          // Plain text is an imported note, never an executable command or new user request.
          memory.append('note', contents);
          console.log('Imported as a historical note.');
        } catch (error) { console.error(error.message); }
        prompt(); return;
      }
      if (line.startsWith('/')) { console.error('Unknown command. Use /model, /view, /zoom, /date, /usage, /backup, /import, /cancel, or /exit.'); prompt(); return; }
      const alreadyActive = runner.active;
      const running = runner.submit(line);
      if (!alreadyActive) void running.then(() => { console.log(); prompt(); });
    });
    rl.on('close', () => { void close(); });
    prompt();
  }
} catch (error) {
  console.error(error.message);
  await runner?.close(); await memory?.stop(); await storage?.close();
  process.exitCode = 1;
}
