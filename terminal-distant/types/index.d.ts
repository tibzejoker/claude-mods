/** Une commande lancée depuis le panneau et ce qu'elle a écrit. */
export type Run = {
  id: number
  cmd: string
  cwd: string
  out: string
  /** null tant qu'elle tourne */
  code: number | null
  signal: string | null
  startedAt: number
  endedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-distant': {
      runs: Run[]
      cwd: string
      /** id de la commande dont la sortie partira avec le prochain message */
      attached: number | null
    }
  }
}
