export type Recap = { text: string; at: number; isLoading: boolean }

declare module 'claude-code' {
  interface PluginState {
    recap: { last: Recap | null }
  }
}
