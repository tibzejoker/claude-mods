import type { EngineInterface, Register } from 'claude-code'

// Chaque secret (mot de passe, jeton, phrase de récupération, carte) des fichiers .env du dossier choisi
// (~/.claude/secrets par défaut) est remplacé par
// [secret:NOM] dans les résultats d'outils avant que le modèle ne les lise.
// Le fichier lui-même reste intact sur le disque : seuls les yeux du modèle changent.

type Secret = { name: string; value: string }

let secrets: Secret[] = []
let masked = 0
let folder = '~/.claude/secrets'

const MIN_LEN = 6
// seulement les vrais secrets : pas les adresses, hôtes, identifiants ou URL
const SECRET_NAME = /(PASS|PW|TOKEN|MNEMONIC|SEED|PRIV|SECRET|HASH|CARD|KEY)/i

async function loadSecrets($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = folder.replace(/^~(?=\/|$)/, home)
  const found: Secret[] = []
  const entries = await $.fs.list(dir).catch(() => [])
  for (const entry of entries) {
    if (!entry.name.endsWith('.env')) continue
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => '')
    for (const line of String(text).split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!m) continue
      const value = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
      if (value.length >= MIN_LEN && SECRET_NAME.test(m[1]!)) {
        found.push({ name: m[1]!, value })
      }
    }
  }
  // les plus longues d'abord, pour qu'une valeur contenue dans une autre ne la coupe pas
  secrets = found.sort((a, b) => b.value.length - a.value.length)
}

function redact(text: string): string {
  let out = text
  for (const s of secrets) {
    if (out.includes(s.value)) {
      const parts = out.split(s.value)
      masked += parts.length - 1
      out = parts.join(`[secret:${s.name}]`)
    }
  }
  return out
}

function redactBlocks(content: unknown): unknown {
  if (typeof content === 'string') return redact(content)
  if (!Array.isArray(content)) return content
  return content.map(block => {
    if (!block || typeof block !== 'object') return block
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') return { ...b, text: redact(b.text) }
    if (b.type === 'tool_result') return { ...b, content: redactBlocks(b.content) }
    return block
  })
}

export const register: Register = (on, options) => {
  folder = String(options.dossier ?? '').trim() || folder

  on('session.start', async ($, e, next) => {
    await loadSecrets($)
    $.clock.every(5 * 60_000, () => void loadSecrets($))
    await $.command.register({ name: 'secrets-masques', description: 'Combien de secrets sont surveillés et masqués' })
    return next(e)
  })

  on('command.run', { command: 'secrets-masques' }, async () => ({
    text: `${secrets.length} valeurs surveillées (${[...new Set(secrets.map(s => s.name))].join(', ') || 'aucune'}), ${masked} masquage(s) dans cette session.`,
  }))

  on('session.append', async ($, e, next) => {
    const isOutside = e.door === 'tool-result' || e.door === 'tool-message' || e.door === 'attachment' || e.door === 'hook-context'
    if (!isOutside || secrets.length === 0) return next(e)
    const before = masked
    const content = redactBlocks(e.message.content) as typeof e.message.content
    if (masked === before) return next(e)
    $.ui.status(`🔒 ${masked} secret${masked > 1 ? 's' : ''} masqué${masked > 1 ? 's' : ''}`)
    return next({ ...e, message: { ...e.message, content } })
  })
}
