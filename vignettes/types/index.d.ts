/** Une image vue dans la session : lue (Read), partagée (SendUserFile) ou rendue par un outil MCP. */
export type Shot = {
  /** clé de cache : le chemin, ou l'id de l'appel d'outil suivi d'un indice */
  key: string
  /** ce qui s'affiche sous l'image */
  label: string
  /** l'outil qui l'a fait voir */
  tool: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    vignettes: { shots: Shot[]; pos: number }
  }
}
