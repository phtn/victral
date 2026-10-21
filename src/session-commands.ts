export const COMMANDS = [
  ['/new', 'Create a fresh, separate session: /new [NAME]'], ['/sessions', 'List saved sessions and mark the current one'],
  ['/session', 'Open a saved session: /session [ID | NUMBER | NAME]'],
  ['/help', 'Show commands and keyboard shortcuts'], ['/tools', 'Inspect agent tool access'],
  ['/plan', 'Inspect the saved task plan'], ['/jobs', 'Inspect background commands'],
  ['/integrations', 'Inspect MCP servers: /integrations [SERVER]'], ['/subagents', 'Research workers: /subagents [ID | stop ID]'],
  ['/metrics', 'Open detailed usage and memory metrics'], ['/jev', 'Show summary evaluations'],
  ['/model', 'List or switch: /model PROVIDER MODEL'], ['/view', 'Inspect the current memory view'],
  ['/zoom', 'Expand memory: /zoom ID N [PAGE]'], ['/date', 'Message timestamp: /date ID'],
  ['/usage', 'Last ten provider usage records'], ['/import', 'Import a transcript: /import FILE'],
  ['/backup', 'Back up this chat: /backup NEW_PATH'], ['/cancel', 'Cancel the current turn'],
  ['/sfx', 'Sound effects: /sfx [on | off]'],
  ['/exit', 'Save and close the session'],
] as const;
