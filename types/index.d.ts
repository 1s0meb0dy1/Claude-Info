export type Snapshot = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  tokens: number | null
  window: number
  usd: number | null
}

export type LastTurn = {
  seconds: number
  output: number
  cachePct: number | null
  usd: number | null
}

export type Meta = {
  startedAt: number
  turns: number
  lastUsd: number | null
  last: LastTurn | null
  /** `kind:resetsAt:threshold` keys already announced by a toast. */
  notified: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: Snapshot | null
      isOpen: boolean
      now: number
      meta: Meta
      isCompact: boolean
    }
  }
}
