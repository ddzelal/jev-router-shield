/** The router's last per-turn decision for this session (GET /__jev/last → last). */
export type Pick = {
  ts: number
  kind: string
  model: string
  effort?: string
  reqModel: string
  reqEffort?: string
  wanted?: string
  level?: string
  conf?: number
  jevMs?: number
  ctxK: number
  risky?: number
  /** inherit | risky | escalated | downgrade */
  notes?: string[]
}

/** The request in flight or last sent, tool-loop steps included (→ live). */
export type Live = { ts: number; kind: string; model: string; effort?: string; ctxK: number; step: number; notes?: string[] }

/** Per-session totals since the proxy started (→ stats). */
export type Stats = {
  since: number
  turns: number
  tiers: Record<string, { req: number; tok: number }>
  downTok: number
  totalTok: number
  costUsd: number
  baseUsd: number
}

/** API-list-price equivalents for today, all sessions. */
export type Today = { day: string; costUsd: number; baseUsd: number }

/** What Claude used: skills, subagents, MCP servers (by server), other tools; counts. */
export type Activity = {
  skills: Record<string, number>
  agents: Record<string, number>
  mcp: Record<string, number>
  tools: Record<string, number>
}

/** `down`: the router did not answer; `off`: this session does not go through it. */
export type Link = 'up' | 'down' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'jev-router-shield': {
      last: Pick | null
      live: Live | null
      stats: Stats | null
      today: Today | null
      paused: boolean
      link: Link
      compact: boolean
      /** since your last message */
      turnAct: Activity
      /** since the session started */
      sessAct: Activity
    }
  }
}
