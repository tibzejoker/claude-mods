export type Mood =
  | 'idle' | 'walk' | 'think' | 'work' | 'wait' | 'sleep'
  | 'compact' | 'done' | 'error' | 'happy' | 'sad' | 'eat' | 'dance'

export type Station = 'shelf' | 'desk' | 'center' | 'term' | 'globe'

export type Tab = 'hud' | 'limits' | 'tools' | 'session'

export type Limit = { kind: string; pct: number; resetsAt?: string }

export type QgState = {
  base: Mood
  flash: Mood | null
  flashUntil: number
  station: Station
  x: number
  walkFrom: number
  walkAt: number
  tool: string
  agents: number
  ctx: number
  ctxTokens: number
  ctxWindow: number
  usd: number
  counts: { shelf: number; desk: number; center: number; term: number; globe: number }
  lastActive: number
  // dashboard
  tab: Tab
  lights: boolean
  model: string
  limits: Limit[]
  tools: Record<string, number>
  calls: number
  errors: number
  files: string[]
  agentsTotal: number
  compactions: number
  turns: number
  startedAt: number
  // the game
  tokens: number
  xp: number
  pets: number
  snacks: number
}

declare module 'claude-code' {
  interface PluginState {
    qg: { s: QgState }
  }
}
