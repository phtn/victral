import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink'
import os from 'node:os'
import { useEffect, useMemo, useRef, useState } from 'react'
import stringWidth from 'string-width'
import { COMMANDS, Session, type SessionState } from './session.js'
import { markdownLines, type MarkdownLine } from './markdown.js'
import { safeText } from './terminal-text.js'
import { formatJevStatus } from './jev-status.js'
export { safeText } from './terminal-text.js'

const VERSION = '0.2.0'
const codexBlue = '#5aa9ff'
const user = '#009393'
const muted = '#8b949e'
const bright = '#e6edf3'
const composerBg = '#333333'
const composerDim = '#9a9a9a'
const statusModel = '#e5c07b'
const statusDot = '#6b7280'
const statusPath = '#98c379'
const errorRed = '#ff7b72'
interface DisplayLine { text?: string; spans?: MarkdownLine['spans']; color: string }
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
  const markdownCache = useRef(new Map<number, { text: string; width: number; lines: DisplayLine[] }>())
  const width = Math.max(10, columns - 2)
  const composerHeight = 3,
    headerHeight = 4,
    statusHeight = 1
  const bodyHeight = Math.max(1, rows - headerHeight - composerHeight - statusHeight - (state.active ? 1 : 0))
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
  const lines = useMemo<DisplayLine[]>(() => {
    if (panel === 'metrics') return wrapLines(session.metrics.detailed(), width).map((text) => ({ text, color: muted }))
    if (!state.entries.length) return []
    const ids = new Set(state.entries.map(entry => entry.id))
    for (const id of markdownCache.current.keys()) if (!ids.has(id)) markdownCache.current.delete(id)
    const lastUser = state.entries.findLast(entry => entry.role === 'you')?.id
    return state.entries.flatMap((entry) => {
      if (entry.role === 'you') {
        return [
          ...wrapLines(entry.text, Math.max(1, width - 2)).map((text) => ({ text: `⟢ ${text}`, color: user })),
          ...(state.active && entry.id === lastUser ? [{ text: '✓ Received', color: muted }] : []),
          { text: '', color: muted }
        ]
      }
      if (entry.role === 'victral') {
        const cached = markdownCache.current.get(entry.id)
        if (cached?.text === entry.text && cached.width === width) return cached.lines
        const rendered = [...markdownLines(entry.text, width).map(line => ({ ...line, color: bright })), { text: '', color: muted }]
        markdownCache.current.set(entry.id, { text: entry.text, width, lines: rendered })
        return rendered
      }
      return [
        ...wrapLines(entry.text, width).map((text) => ({ text, color: entry.role === 'error' ? errorRed : muted })),
        { text: '', color: muted }
      ]
    })
  }, [state.entries, state.active, panel, width, session])
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
  const jevStatus = state.jev ? formatJevStatus(state.jev, Math.max(12, width - 13)) : ''
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
                {line.spans ? line.spans.map(({ text, ...style }, index) => <Text key={index} {...style}>{text}</Text>) : line.text || ' '}
              </Text>
            ))}
      </Box>
      {state.active ? (
        <Box height={1} paddingX={1} flexShrink={0}>
          <Text color={codexBlue} wrap='truncate-end'>{`${spinner} Working · ${safeText(state.phase)}`}</Text>
        </Box>
      ) : null}
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
      <Box height={1} paddingX={1} flexShrink={0}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap='truncate-end'>
            <Text color={statusModel}>{safeText(state.model)}</Text>
            <Text color={statusDot}>{' · '}</Text>
            <Text color={statusPath}>{project}</Text>
          </Text>
        </Box>
        {statusRight ? (
          <Box marginLeft={1} flexShrink={1} minWidth={0}>
            <Text color={muted} wrap='truncate-end'>{statusRight}</Text>
          </Box>
        ) : null}
        {jevStatus ? (
          <Box marginLeft={1} width={stringWidth(jevStatus)} flexShrink={0}>
            <Text color={state.jev?.errors ? errorRed : muted} wrap='truncate-end'>{jevStatus}</Text>
          </Box>
        ) : null}
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
