export const COMMANDS = [
  ['/help', 'Show commands and keyboard shortcuts'], ['/tools', 'Inspect agent tool access'],
  ['/plan', 'Inspect the saved task plan'], ['/jobs', 'Inspect background commands'],
  ['/metrics', 'Open detailed usage and memory metrics'], ['/jev', 'Show summary evaluations'],
  ['/model', 'List or switch models'], ['/view', 'Inspect the current memory view'],
  ['/zoom', 'Expand memory: /zoom ID N [PAGE]'], ['/date', 'Message timestamp: /date ID'],
  ['/usage', 'Last ten provider usage records'], ['/import', 'Import a transcript: /import FILE'],
  ['/backup', 'Back up this chat: /backup NEW_PATH'], ['/cancel', 'Cancel the current turn'],
  ['/exit', 'Save and close the session'],
] as const;
