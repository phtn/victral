import fs from 'node:fs';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8').trimEnd();
const shared = [read('MASTER.txt'), read('VIEW_DOC.txt'), read('COMPACT.txt')].join('\n\n');
export const systemPrompt = (instructions = '') => [shared, instructions].filter(Boolean).join('\n\n');
