import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink'
import os from 'node:os'
import { useEffect, useMemo, useState } from 'react'
import stringWidth from 'string-width'
import { COMMANDS, Session, type SessionState } from './session.js'

const VERSION = '0.2.0'
const codexBlue = '#5aa9ff'
const muted = '#8b949e'
const bright = '#e6edf3'
const composerBg = '#333333'
const composerDim = '#9a9a9a'
const statusModel = '#e5c07b'
const statusDot = '#6b7280'
const statusPath = '#98c379'
const errorRed = '#ff7b72'
// Provider output and project names are data, never terminal control sequences.
export function safeText(text: string): string {
  return text
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\t/g, '  ')
}
export function wrapLines(text: string, width: number): string[] {
  const result: string[] = []
  for (const line of safeText(text).split('\n')) {
    let current = '',
      columns = 0
    for (const char of line) {
      const size = stringWidth(char)
      if (columns + size > width && current) {
        result.push(current)
        current = ''
        columns = 0
      }
      current += char
      columns += size
    }
    result.push(current)
  }
  return result
}
function useSession(session: WorkspaceSession): SessionState {
  const [state, setState] = useState(() => session.snapshot())
  useEffect(() => {
    const update = () => setState(session.snapshot())
    session.on('update', update)
    update()
    return () => {
      session.off('update', update)
    }
  }, [session])
  return state
}
export interface WorkspaceSession extends Pick<Session, 'snapshot' | 'submit' | 'cancel' | 'close'> {
  on(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
  options: { project: string; allowShell: boolean }
  metrics: { detailed(): string }
}

export function shortProject(project: string): string {
  const home = os.homedir()
  if (project === home) return '~'
  if (project.startsWith(home + '/')) return `~/${project.slice(home.length + 1)}`
  return project
}

export function Workspace({ session }: { session: WorkspaceSession }) {
  const state = useSession(session),
    { columns, rows } = useWindowSize(),
    { exit } = useApp()
  const [input, setInput] = useState(''),
    [cursor, setCursor] = useState(0),
    [scroll, setScroll] = useState(0)
  const [panel, setPanel] = useState<'chat' | 'metrics' | 'commands'>('chat')
  const [selected, setSelected] = useState(0),
    [history, setHistory] = useState<string[]>([]),
    [historyIndex, setHistoryIndex] = useState(-1)
  const [tick, setTick] = useState(0)
  const width = Math.max(10, columns - 2)
  const composerHeight = 3,
    headerHeight = 4,
    statusHeight = 1
  const bodyHeight = Math.max(1, rows - headerHeight - composerHeight - statusHeight)
  useEffect(() => {
    const closed = () => exit()
    session.on('closed', closed)
    return () => {
      session.off('closed', closed)
    }
  }, [session, exit])
  useEffect(() => {
    if (!state.active) return
    const timer = setInterval(() => setTick((t) => t + 1), 160)
    return () => clearInterval(timer)
  }, [state.active])
  const project = shortProject(safeText(session.options.project))
  const lines = useMemo(() => {
    if (panel === 'metrics') return wrapLines(session.metrics.detailed(), width).map((text) => ({ text, color: muted }))
    if (!state.entries.length) return []
    return state.entries.flatMap((entry) => {
      if (entry.role === 'you') {
        return [
          ...wrapLines(entry.text, Math.max(1, width - 2)).map((text) => ({ text: `> ${text}`, color: bright })),
          { text: '', color: muted }
        ]
      }
      if (entry.role === 'victral') {
        return [...wrapLines(entry.text, width).map((text) => ({ text, color: bright })), { text: '', color: muted }]
      }
      return [
        ...wrapLines(entry.text, width).map((text) => ({ text, color: entry.role === 'error' ? errorRed : muted })),
        { text: '', color: muted }
      ]
    })
  }, [state.entries, panel, width, session])
  const maxScroll = Math.max(0, lines.length - bodyHeight),
    offset = Math.min(scroll, maxScroll)
  const visible = lines.slice(Math.max(0, lines.length - bodyHeight - offset), lines.length - offset)
  const menu = COMMANDS.slice(
    Math.max(0, selected - Math.floor(bodyHeight / 2)),
    Math.max(0, selected - Math.floor(bodyHeight / 2)) + bodyHeight
  )
  const submit = (value: string) => {
    if (!value.trim()) return
    setInput('')
    setCursor(0)
    setScroll(0)
    setPanel('chat')
    setHistoryIndex(-1)
    setHistory((prev) => [...prev.slice(-99), value])
    void session.submit(value).catch((error) => {
      void session.close().finally(() => exit(error))
    })
  }
  useInput((key, event) => {
    if (event.ctrl && key === 'c') {
      if (state.active) session.cancel()
      else void session.close()
      return
    }
    if (event.escape) {
      if (panel !== 'chat') setPanel('chat')
      else if (state.active) session.cancel()
      return
    }
    if (event.ctrl && key === 'p') {
      setPanel((prev) => (prev === 'commands' ? 'chat' : 'commands'))
      setSelected(0)
      return
    }
    if (event.ctrl && key === 'o') {
      setPanel((prev) => (prev === 'metrics' ? 'chat' : 'metrics'))
      setScroll(0)
      return
    }
    if (event.pageUp) {
      setScroll((prev) => Math.min(maxScroll, prev + bodyHeight))
      return
    }
    if (event.pageDown) {
      setScroll((prev) => Math.max(0, prev - bodyHeight))
      return
    }
    if (panel === 'commands') {
      if (event.upArrow) setSelected((prev) => Math.max(0, prev - 1))
      if (event.downArrow) setSelected((prev) => Math.min(COMMANDS.length - 1, prev + 1))
      if (event.return) {
        const value = COMMANDS[selected]![0] + ' '
        setInput(value)
        setCursor(value.length)
        setPanel('chat')
      }
      return
    }
    if (event.upArrow || event.downArrow) {
      const index = event.upArrow ? Math.min(history.length - 1, historyIndex + 1) : Math.max(-1, historyIndex - 1)
      setHistoryIndex(index)
      const value = index < 0 ? '' : (history[history.length - 1 - index] ?? '')
      setInput(value)
      setCursor(Array.from(value).length)
      return
    }
    const chars = Array.from(input)
    if (event.return) {
      submit(input)
      return
    }
    if (event.leftArrow) {
      setCursor(Math.max(0, cursor - 1))
      return
    }
    if (event.rightArrow) {
      setCursor(Math.min(chars.length, cursor + 1))
      return
    }
    if (event.ctrl) {
      if (key === 'a') setCursor(0)
      if (key === 'e') setCursor(chars.length)
      if (key === 'u') {
        setInput(chars.slice(cursor).join(''))
        setCursor(0)
      }
      return
    }
    if (event.backspace || event.delete) {
      if (cursor > 0) {
        chars.splice(cursor - 1, 1)
        setInput(chars.join(''))
        setCursor(cursor - 1)
      }
      return
    }
    const value = safeText(key).replace(/\r/g, '\n')
    if (value) {
      chars.splice(cursor, 0, value)
      setInput(chars.join(''))
      setCursor(cursor + Array.from(value).length)
    }
  })
  const inputChars = Array.from(input.replace(/\n/g, '↵'))
  let start = cursor
  let available = Math.max(1, columns - 6)
  while (start > 0 && stringWidth(inputChars.slice(start - 1, cursor).join('')) < available - 2) start--
  const beforeCursor = inputChars.slice(start, cursor).join('')
  const afterCursor = inputChars.slice(cursor + 1).join('')
  const spinner = ['◐', '◓', '◑', '◒'][tick % 4]
  const statusRight = offset
    ? `↑ ${offset} lines`
    : panel === 'metrics'
      ? 'METRICS'
      : panel === 'commands'
        ? 'COMMANDS'
        : state.active
          ? `${spinner} ${state.phase}`
          : ''
  if (rows < 16 || columns < 42)
    return (
      <Box flexDirection='column'>
        <Text color={codexBlue}>VICTRAL · resize terminal</Text>
        <Text>Use at least 42 columns × 16 rows.</Text>
        <Text>Ctrl+C to close, or start with --plain.</Text>
      </Box>
    )
  return (
    <Box flexDirection='column' width={columns} height={rows}>
      <Box
        flexDirection='row'
        width={columns}
        justifyContent='space-between'
        paddingX={1}
        paddingTop={1}
        flexShrink={0}>
        <Text wrap='truncate-end'>
          <Text color={codexBlue}>{'💲 '}</Text>
          <Text bold color={bright}>
            Victral
          </Text>
          <Text color={muted}>{` (v${VERSION})`}</Text>
        </Text>
        <Text color={muted} wrap='truncate-end'>{`  ${project}`}</Text>
        <Text></Text>
      </Box>
      <Box flexDirection='column' paddingX={1} flexGrow={1} flexShrink={1}>
        {!state.entries.length && panel === 'chat' ? <Text color={codexBlue}>A half-formed idea will do.</Text> : null}
        {panel === 'commands'
          ? menu.map(([command, description]) => (
              <Text key={command} color={COMMANDS[selected]![0] === command ? codexBlue : muted} wrap='truncate-end'>
                {COMMANDS[selected]![0] === command ? '⟢ ' : '  '}
                {command.padEnd(10)} {description}
              </Text>
            ))
          : visible.map((line, index) => (
              <Text key={index} color={line.color} wrap='truncate-end'>
                {line.text || ' '}
              </Text>
            ))}
      </Box>
      <Box backgroundColor={composerBg} paddingX={1} paddingY={1} flexShrink={0}>
        <Text wrap='truncate-end'>
          <Text color={bright}>{'⧽ '}</Text>
          {input ? (
            <>
              <Text color={bright}>{beforeCursor}</Text>
              <Text inverse={panel !== 'commands'}>{inputChars[cursor] ?? ' '}</Text>
              <Text color={bright}>{afterCursor}</Text>
            </>
          ) : (
            <>
              <Text inverse={panel !== 'commands'}> </Text>
              <Text color={composerDim}>
                {state.active
                  ? 'Steer the agent while it works…'
                  : panel === 'commands'
                    ? 'Type a command…'
                    : panel === 'metrics'
                      ? 'Metrics open · Esc to return…'
                      : 'Ask anything about your project…'}
              </Text>
            </>
          )}
        </Text>
      </Box>
      <Box height={1} paddingX={1} justifyContent='space-between' flexShrink={0}>
        <Text wrap='truncate-end'>
          <Text color={statusModel}>{safeText(state.model)}</Text>
          <Text color={statusDot}>{' · '}</Text>
          <Text color={statusPath}>{project}</Text>
        </Text>
        <Text color={muted} wrap='truncate-end'>
          {statusRight}
        </Text>
      </Box>
    </Box>
  )
}
export async function startTui(session: WorkspaceSession): Promise<void> {
  const instance = render(<Workspace session={session} />, { exitOnCtrlC: false, alternateScreen: true, maxFps: 24 })
  try {
    await instance.waitUntilExit()
  } finally {
    instance.cleanup()
    await session.close()
  }
}
