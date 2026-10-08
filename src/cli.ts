#!/usr/bin/env bun
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { parseArgs } from 'node:util'
import { MODEL } from './constants.js'
import { formatModelsList, resolveModelId } from './models.js'
import { Session } from './session.js'
import { errorMessage } from './types.js'

const HELP = `Victral · a persistent coding workspace

Usage: victral [options]

  --project PATH          Project root (default: current directory)
  --chat-dir PATH         Persistent chat directory
  --model ID              Main agent model (number, short name, or full ID; see --models)
  --compactor-model ID    Background memory model (same format; defaults to --model)
  --instructions FILE     Load custom instructions instead of AGENTS.md
  --allow-shell           Enable run_command and shell agent tools
  --ask TEXT              Run one turn, then exit
  --plain                 Use a line-oriented terminal (automatic for pipes)
  --tui                   Require the full-screen terminal interface
  --demo                  Preview the interface without API calls or saved data
  --models                List models
  --no-jev                Disable background evaluation
  --no-metrics            Hide automatic metrics
  --help, -h              Show this help
  --version, -v           Show version

In the workspace: Ctrl+P commands · Ctrl+O metrics · Esc cancel
Agent tools: files, exact edits, search, URL fetching, Git status/diff, optional CLI execution.
`
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string', default: process.cwd() },
      'chat-dir': { type: 'string', default: path.join(os.homedir(), '.local/share/victral/chat') },
      instructions: { type: 'string' },
      ask: { type: 'string' },
      'allow-shell': { type: 'boolean', default: false },
      model: { type: 'string' },
      'compactor-model': { type: 'string' },
      models: { type: 'boolean' },
      'no-jev': { type: 'boolean', default: false },
      'no-metrics': { type: 'boolean', default: false },
      plain: { type: 'boolean', default: false },
      tui: { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  if (values.version) {
    console.log('0.2.0')
    return
  }
  if (values.models) {
    console.log(`Available models:\n${formatModelsList()}\n\nSelect with --model <number, short name, or ID>, e.g. --model ms1.3c.`)
    return
  }
  if (values.plain && values.tui) throw new Error('Choose either --plain or --tui.')
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (values.tui && !interactive)
    throw new Error('--tui requires an interactive terminal. Use --plain or --ask for pipes.')
  if (values.demo) {
    if (!interactive || values.plain || values.ask !== undefined) throw new Error('--demo requires an interactive TUI.')
    const { startDemo } = await import('./demo.js')
    await startDemo()
    return
  }
  const project = fs.realpathSync(values.project)
  if (!fs.statSync(project).isDirectory()) throw new Error('--project must select a directory.')
  const model = resolveModelId(values.model ?? process.env.VICTRAL_MODEL ?? MODEL)
  const session = await Session.open({
    project,
    chatDir: path.resolve(values['chat-dir']),
    model,
    compactorModel: resolveModelId(
      values['compactor-model'] ?? process.env.VICTRAL_COMPACTOR_MODEL ?? model),
    instructions: values.instructions,
    allowShell: values['allow-shell'],
    jev: !values['no-jev'],
    metrics: !values['no-metrics']
  })
  const terminate = () => {
    void session.close()
  }
  process.on('SIGTERM', terminate)
  try {
    if (values.ask !== undefined) {
      session.on('text', (text) => process.stdout.write(text))
      session.on('errorText', (text) => {
        console.error(`\n${text}`)
        process.exitCode = 1
      })
      const controller = new AbortController()
      const cancel = () => {
        session.cancel()
        controller.abort()
        process.exitCode = 130
      }
      process.on('SIGINT', cancel)
      try {
        await session.submit(values.ask)
        console.log()
        await session.settle(controller.signal)
        if (!values['no-metrics']) console.log(session.metrics.detailed())
      } finally {
        process.off('SIGINT', cancel)
      }
    } else if (interactive && !values.plain) {
      const { startTui } = await import('./tui.js')
      await startTui(session)
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: interactive,
        prompt: 'victral ⟢ '
      })
      const prompt = () => {
        if (interactive) rl.prompt()
      }
      console.log(`Victral · ${model}\nProject: ${project}\nType /help for commands.\n`)
      session.on('text', (text) => process.stdout.write(text))
      session.on('notice', (text) => {
        console.log(text)
        prompt()
      })
      session.on('errorText', (text) => {
        console.error(`\n${text}`)
        if (!interactive) process.exitCode = 1
        prompt()
      })
      session.on('idle', () => {
        console.log()
        if (!values['no-metrics']) console.log(session.metrics.compact())
        prompt()
      })
      session.on('closed', () => rl.close())
      rl.on('SIGINT', () => {
        if (session.snapshot().active) session.cancel()
        else void session.close()
      })
      const pending = new Set<Promise<void>>()
      rl.on('line', (line) => {
        const work = session.submit(line)
        pending.add(work)
        void work
          .catch((error) => {
            console.error(errorMessage(error))
            process.exitCode = 1
          })
          .finally(() => {
            pending.delete(work)
            prompt()
          })
      })
      await new Promise<void>((resolve) => {
        rl.once('close', resolve)
        prompt()
      })
      // EOF is normal input completion: finish queued requests before closing.
      await Promise.allSettled([...pending])
    }
  } finally {
    process.off('SIGTERM', terminate)
    await session.close()
  }
}
await main().catch((error) => {
  console.error(`Victral: ${errorMessage(error)}`)
  process.exitCode = 1
})
