export const MODEL_INFO = [
  { id: 'muse-spark-1.3', shortName: 'ms1.3', provider: 'Meta', credential: 'META_API_KEY or MODEL_API_KEY' },
  { id: 'muse-spark-1.3-contributor', shortName: 'ms1.3c', provider: 'Meta', credential: 'META_API_KEY or MODEL_API_KEY' },
  { id: 'gpt-6-luna', shortName: 'luna6', provider: 'OpenAI', credential: 'OPENAI_API_KEY' },
  { id: 'gpt-6.1-sol', shortName: 'sol6.1', provider: 'OpenAI', credential: 'OPENAI_API_KEY' },
];
export const PROVIDERS = [...new Set(MODEL_INFO.map(entry => entry.provider.toLowerCase()))];
export const MODELS = MODEL_INFO.map(entry => entry.id);
export const findModel = (lowered: string) => MODEL_INFO.find(entry => entry.id.toLowerCase() === lowered || entry.shortName === lowered);
export function shortModelName(model: string) {
  return findModel(String(model).trim().toLowerCase())?.shortName ?? model;
}
export function formatModelsList(provider?: string) {
  return MODEL_INFO.flatMap((entry, index) => !provider || entry.provider.toLowerCase() === provider.toLowerCase()
    ? [`  ${index + 1}. ${entry.id} (${entry.provider}; alias ${entry.shortName}; needs ${entry.credential})`] : []).join('\n');
}
// Resolve exact aliases before partial IDs, so ms1.3 selects Standard even
// though the Contributor alias starts with the same characters.
export function resolveModelId(input: unknown) {
  let text = String(input ?? '').trim();
  const parts = text.split(/\s+/);
  const provider = PROVIDERS.includes(parts[0]?.toLowerCase()) ? parts.shift()!.toLowerCase() : undefined;
  if (provider) text = parts.join(' ');
  const choices = MODEL_INFO.filter(entry => !provider || entry.provider.toLowerCase() === provider);
  const list = formatModelsList(provider);
  const hint = 'Use /model <provider> <short name or ID>, e.g. /model openai luna6. Numbers and model-only shortcuts also work.';
  if (!text) throw new Error(`Choose a model:\n${list}\n${hint}`);
  const index = Number(text);
  if (/^\d+$/.test(text)) {
    if (Number.isSafeInteger(index) && index >= 1 && index <= MODEL_INFO.length && choices.includes(MODEL_INFO[index - 1])) return MODEL_INFO[index - 1].id;
    throw new Error(`Model number must be between 1 and ${MODEL_INFO.length}${provider ? ` and belong to ${provider}` : ''}.\n${list}`);
  }
  const lowered = text.toLowerCase();
  const exact = findModel(lowered);
  if (exact && choices.includes(exact)) return exact.id;
  const matches = choices.filter(entry => entry.id.toLowerCase().includes(lowered) || entry.shortName.startsWith(lowered));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`"${text}" matches several models:\n${list}\n${hint}`);
  throw new Error(`Unknown model "${text}"${provider ? ` for ${provider}` : ''}. Available models:\n${list}\n${hint}`);
}
