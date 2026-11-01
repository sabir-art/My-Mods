export type Team = {
  id: string
  title: string
  bucket: string
  summary?: string
  model?: string
  ctxUsed?: number
  ctxMax?: number
}

export type AgentUse = { tokens: number; requests: number }

export type Board = {
  teams: Team[]
  fetchedAt: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    equipes: {
      board: Shaped<Board>
      agentUse: Shaped<Record<string, AgentUse>>
      collapsed: Shaped<Record<string, boolean>>
    }
  }
}
