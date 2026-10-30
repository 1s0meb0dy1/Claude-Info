export type Snapshot = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  tokens: number | null
  window: number
  usd: number | null
}

export type Meta = { startedAt: number; turns: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: Snapshot | null
      isOpen: boolean
      now: number
      meta: Meta
    }
  }
}
