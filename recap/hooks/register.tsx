import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// /recap : une question posée « à côté » de la conversation (même cache, aucun
// outil, rien n'est ajouté au fil) qui résume la session dans un panneau.
// Pratique avant de fermer, pour une passation ou une note de journal.

const PANE = 'recap'
const last = atom({ plugin: 'recap', key: 'last' } as const, null)

let prompt = ''

function buildPrompt(langue: string, consignes: string): string {
  return [
    `Fais le point de cette session, en ${langue || 'français'}.`,
    'Trois rubriques en markdown, courtes, factuelles, avec les chemins de fichiers utiles :',
    '## Fait (ce qui est terminé et vérifié)',
    '## En cours ou en attente (ce qui attend quelqu\'un ou quelque chose, avec quoi)',
    '## Prochaines étapes (au plus 3, la plus importante d\'abord)',
    'Pas d\'introduction ni de conclusion. Si une info n\'est pas sûre, dis-le.',
    consignes,
  ].filter(Boolean).join('\n')
}

async function run($: EngineInterface) {
  await update($, last, prev => ({ text: prev?.text ?? '', at: prev?.at ?? 0, isLoading: true }))
  const r = await $.model.fork({ prompt })
  const now = await $.clock.now()
  const text = r.isAnswered ? r.text.trim() : `Pas de récap possible (${r.reason}).`
  await update($, last, () => ({ text, at: now, isLoading: false }))
}

async function copy($: EngineInterface) {
  const r = await read($, last)
  if (r?.text) {
    await $.ui.copy({ text: r.text })
    $.ui.toast('Récap copié')
  }
}

export const register: Register = (on, options) => {
  prompt = buildPrompt(String(options.langue ?? ''), String(options.consignes ?? ''))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'recap', description: 'Résumé de la session (fait, en attente, prochaines étapes) dans un panneau' })
    return next(e)
  })

  on('command.run', { command: 'recap' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Récap', focus: true, closeOnEscape: true })
    void run($)
    return { text: 'Récap en cours de rédaction dans le panneau.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const r = await read($, last)
    return (
      <Box flexDirection="column">
        {r?.isLoading && <Text dimColor>Je relis la session…</Text>}
        {r?.text ? <Markdown text={r.text} /> : !r?.isLoading && <Text dimColor>Tape /recap pour lancer.</Text>}
        <Box>
          <Button key="copy" label="Copier" hotkey="c" variant="primary" onPress={() => copy($)} />
          <Button key="again" label="Refaire" hotkey="r" onPress={() => run($)} />
        </Box>
      </Box>
    )
  })
}
