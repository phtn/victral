import stringWidth from 'string-width'

export interface JevStatus {
  state: string
  completed: number
  pending: number
  errors: number
  skipped: number
  risks?: { unsupported: number; omitted: number; inflated: number }
}
const count = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

export function formatJevStatus(jev: JevStatus, width: number): string {
  const label = jev.state === 'disabled' ? 'Jev off' : jev.state === 'missing TYPESAFE_API_KEY' ? 'Jev no key' : 'Jev'
  const completed = `${count.format(jev.completed)}✓`
  const pending = jev.pending ? ` ${count.format(jev.pending)}…` : ''
  const errors = jev.errors ? ` ${count.format(jev.errors)}!` : ''
  const skipped = jev.skipped ? ` ${count.format(jev.skipped)}-` : ''
  const risks = jev.risks
    ? `U${Math.round(jev.risks.unsupported * 100)}% O${Math.round(jev.risks.omitted * 100)}% P${Math.round(jev.risks.inflated * 100)}%`
    : ''
  const counts = `${label} ${completed}${pending}${errors}`
  const variants = [
    `${counts}${skipped}${risks ? ` · ${risks}` : ''}`,
    `${counts}${risks ? ` ${risks}` : ''}`,
    counts,
    `${label} ${completed}`,
    label
  ]
  return variants.find((text) => stringWidth(text) <= width) ?? 'Jev'
}
