export const MODEL_INFO = [
  { id: 'north-mini-code-1-0', shortName: 'north-mini', provider: 'Cohere', credential: 'COHERE_API_KEY' },
  { id: 'command-a-03-2025', shortName: 'command-a', provider: 'Cohere', credential: 'COHERE_API_KEY' },
  { id: 'command-a-plus-05-2026', shortName: 'command-a-plus', provider: 'Cohere', credential: 'COHERE_API_KEY' },
  { id: 'muse-wonder-1.0', shortName: 'mw1.0', provider: 'Meta', credential: 'META_API_KEY or MODEL_API_KEY' },
  { id: 'muse-wonder-full', shortName: 'mwfull', provider: 'Meta', credential: 'META_API_KEY or MODEL_API_KEY' },
  { id: 'gpt-6-luna', shortName: 'luna6', provider: 'OpenAI', credential: 'OPENAI_API_KEY' },
  { id: 'gpt-6.1-sol', shortName: 'sol6.1', provider: 'OpenAI', credential: 'OPENAI_API_KEY' },
  { id: 'claude-sonnet-5-5', shortName: 'sonnet5.5', provider: 'Anthropic', credential: 'ANTHROPIC_API_KEY' },
  { id: 'claude-opus-5-5', shortName: 'opus5.5', provider: 'Anthropic', credential: 'ANTHROPIC_API_KEY' },
  {
    id: '@cf/meta/llama-3.2-1b-instruct',
    shortName: 'cf-llama1b',
    provider: 'Cloudflare',
    credential: 'CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID'
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    shortName: 'cf-glm47',
    provider: 'Cloudflare',
    credential: 'CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID'
  },
  {
    id: 'mlx-community/Qwen3.5-4B-OptiQ-4bit',
    shortName: 'optiq',
    provider: 'MLX',
    credential: 'none (local MLX_BASE_URL, default http://127.0.0.1:8080)'
  },
  {
    id: 'mlx-community/Qwen3.5-4B-MLX-4bit',
    shortName: 'mlx',
    provider: 'MLX',
    credential: 'none (local MLX_BASE_URL, default http://127.0.0.1:8080)'
  },
  {
    id: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    shortName: 'llama3b',
    provider: 'MLX',
    credential: 'none (local MLX_BASE_URL, default http://127.0.0.1:8080)'
  }
]
// 'local' names the MLX provider the way it is selected in conversation.
const PROVIDER_ALIASES: Record<string, string> = { local: 'mlx' }
export const PROVIDERS = [...new Set(MODEL_INFO.map((entry) => entry.provider.toLowerCase()))]
export const MODELS = MODEL_INFO.map((entry) => entry.id)
export const findModel = (lowered: string) =>
  MODEL_INFO.find((entry) => entry.id.toLowerCase() === lowered || entry.shortName === lowered)
export function shortModelName(model: string) {
  return findModel(String(model).trim().toLowerCase())?.shortName ?? model
}
export function formatModelsList(provider?: string) {
  return MODEL_INFO.flatMap((entry, index) =>
    !provider || entry.provider.toLowerCase() === provider.toLowerCase()
      ? [`  ${index + 1}. ${entry.id} (${entry.provider}; alias ${entry.shortName}; needs ${entry.credential})`]
      : []
  ).join('\n')
}
// Resolve exact aliases before partial IDs so a shorter alias can share a prefix.
export function resolveModelId(input: unknown) {
  let text = String(input ?? '').trim()
  const parts = text.split(/\s+/)
  const named = parts[0]?.toLowerCase()
  const candidate = named ? (PROVIDER_ALIASES[named] ?? named) : undefined
  const provider = candidate && PROVIDERS.includes(candidate) ? (parts.shift(), candidate) : undefined
  if (provider) text = parts.join(' ')
  const choices = MODEL_INFO.filter((entry) => !provider || entry.provider.toLowerCase() === provider)
  const list = formatModelsList(provider)
  const hint =
    'Use /model <provider> <short name or ID>, e.g. /model openai luna6. Numbers and model-only shortcuts also work.'
  if (!text) throw new Error(`Choose a model:\n${list}\n${hint}`)
  const index = Number(text)
  if (/^\d+$/.test(text)) {
    if (
      Number.isSafeInteger(index) &&
      index >= 1 &&
      index <= MODEL_INFO.length &&
      choices.includes(MODEL_INFO[index - 1])
    )
      return MODEL_INFO[index - 1].id
    throw new Error(
      `Model number must be between 1 and ${MODEL_INFO.length}${provider ? ` and belong to ${provider}` : ''}.\n${list}`
    )
  }
  const lowered = text.toLowerCase()
  const exact = findModel(lowered)
  if (exact && choices.includes(exact)) return exact.id
  const matches = choices.filter(
    (entry) => entry.id.toLowerCase().includes(lowered) || entry.shortName.startsWith(lowered)
  )
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) throw new Error(`"${text}" matches several models:\n${list}\n${hint}`)
  throw new Error(`Unknown model "${text}"${provider ? ` for ${provider}` : ''}. Available models:\n${list}\n${hint}`)
}
