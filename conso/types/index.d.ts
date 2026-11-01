export type Totals = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Measure = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  costUsd?: number
  limits: Limit[]
}

export type LastTurn = Totals & { model: string }

declare module 'claude-code' {
  interface PluginState {
    conso: {
      totals: Shaped<Totals>
      measure: Shaped<Measure | null>
      lastTurn: Shaped<LastTurn | null>
      lastRequestAt: Shaped<number | null>
    }
  }
}
