// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

/** What the router answers on GET /__jev/last for one Claude Code session (see src/server.ts). */
export interface JevCard {
  paused: boolean
  last: {
    ts: number; kind: string; model: string; effort?: string; reqModel: string; reqEffort?: string; wanted?: string
    level?: string; conf?: number; jevMs?: number; ctxK: number; risky?: number; notes?: string[]
  } | null
  live: {
    ts: number; kind: string; model: string; effort?: string; ctxK: number; step: number; notes?: string[]
    turnStart?: number; used?: Record<string, number>
  } | null
  stats: {
    since: number; turns: number; tiers: Record<string, { req: number; tok: number }>
    downTok: number; totalTok: number; costUsd: number; baseUsd: number
  } | null
  today: { day: string; costUsd: number; baseUsd: number } | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Watch these Claude Code session ids; answers the cards it has now. */
    'jev.watch': { input: { sessions: string[] }; output: { router: boolean; cards: Record<string, JevCard> } }
  }
  interface PluginPanelEvents {
    /** A watched session's card changed (or the router went up/down). */
    'jev.update': { router: boolean; session?: string; card?: JevCard }
  }
}
