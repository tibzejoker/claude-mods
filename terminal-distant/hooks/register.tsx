import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'

// /terminal ouvre un panneau qui lance des commandes sur la machine où tourne
// la session : pratique depuis l'appli desktop ou le téléphone connectés en
// Remote Control, quand on n'a pas de shell sous la main.
//
// Une commande à la fois, sortie en direct, `cd` retenu d'une commande à
// l'autre. Ce n'est pas un vrai TTY : pas de vim, pas de top, pas de saisie
// clavier pendant l'exécution (l'entrée standard est fermée).
// Le modèle ne voit rien de tout ça, sauf la sortie qu'on choisit de joindre.

const PANE = 'terminal-distant'
const KEEP_RUNS = 30
const MAX_OUT = 64_000
const SHOWN_RUNS = 6
const SHOWN_LINES = 120
const MARK = '\u001eCWD:'

const runs = atom({ plugin: 'terminal-distant', key: 'runs' } as const, [])
const cwdAtom = atom({ plugin: 'terminal-distant', key: 'cwd' } as const, '')
const attached = atom({ plugin: 'terminal-distant', key: 'attached' } as const, null)

let shell = 'sh'
let presets: string[] = []
let pid: number | null = null
let busy = false
let nextId = 1

function clean(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.slice(l.lastIndexOf('\r') + 1))
    .join('\n')
}

async function patch($: EngineInterface, id: number, fn: (r: Run) => Run) {
  await update($, runs, list => list.map(r => (r.id === id ? fn(r) : r)))
}

async function exec($: EngineInterface, cmd: string) {
  cmd = cmd.trim()
  if (!cmd) return
  if (busy) {
    $.ui.toast('Une commande tourne déjà : Stop d\'abord')
    return
  }
  busy = true
  const cwd = (await read($, cwdAtom)) || '.'
  const id = nextId++
  const startedAt = await $.clock.now()
  await update($, runs, list => [...list, { id, cmd, cwd, out: '', code: null, signal: null, startedAt, endedAt: 0 }].slice(-KEEP_RUNS))

  // le shell donne son pid (pour Stop), lance la commande, puis dit où il a fini (pour cd)
  const wrapped = `${cmd}\n__rc=$?; printf '\\n${MARK}%s\\n' "$PWD"; exit $__rc`
  const argv = ['sh', '-c', 'printf "PID:%s\\n" $$; exec "$0" -lc "$1"', shell, wrapped]
  let raw = ''
  let shown = ''
  let flushedAt = 0
  try {
    const stream = $.process.spawn({ argv, cwd, env: { TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' } })
    for await (const chunk of stream) {
      raw += chunk.text
      if (pid === null) {
        const m = /^PID:(\d+)\n/.exec(raw)
        if (m) {
          pid = Number(m[1])
          raw = raw.slice(m[0].length)
        }
      }
      shown = clean(raw.split(MARK)[0]!)
      if (shown.length > MAX_OUT) shown = '…\n' + shown.slice(-MAX_OUT)
      const now = Date.now()
      if (now - flushedAt > 150) {
        flushedAt = now
        const out = shown
        await patch($, id, r => ({ ...r, out }))
      }
    }
    const end = await stream.result
    const where = raw.split(MARK)[1]?.split('\n')[0]?.trim()
    if (where) await update($, cwdAtom, () => where)
    const endedAt = await $.clock.now()
    const out = shown.replace(/\n$/, '')
    await patch($, id, r => ({ ...r, out, code: end.code, signal: end.signal, endedAt }))
  } catch (err) {
    const endedAt = await $.clock.now()
    await patch($, id, r => ({ ...r, out: `${shown}\n(${String(err)})`, code: 127, endedAt }))
  } finally {
    pid = null
    busy = false
    $.ui.invalidate('ui.render')
  }
}

async function stop($: EngineInterface) {
  if (pid === null) return
  // le shell d'abord (sinon il enchaîne sur la suite de la ligne), puis toute sa descendance ;
  // pgrep -P existe sous Linux comme sous macOS
  const script = 'd() { for c in $(pgrep -P "$1"); do d "$c"; echo "$c"; done; }; all=$(d "$1"); kill -TERM "$1" 2>/dev/null; '
    + '[ -n "$all" ] && kill -INT $all 2>/dev/null; sleep 1; [ -n "$all" ] && kill -KILL $all 2>/dev/null; true'
  await $.process.run(['sh', '-c', script, 'stop', String(pid)]).catch(() => null)
}

async function attach($: EngineInterface, id: number) {
  await update($, attached, cur => (cur === id ? null : id))
  const on = (await read($, attached)) === id
  $.ui.toast(on ? 'Sortie jointe à ton prochain message' : 'Sortie retirée')
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min${String(s % 60).padStart(2, '0')}`
}

export const register: Register = (on, options) => {
  presets = String(options.raccourcis ?? '').split('|').map(s => s.trim()).filter(Boolean).slice(0, 8)

  on('session.start', async ($, e, next) => {
    // le wrapper parle POSIX : fish, nu et les autres passent par sh
    const login = (await $.env.get('SHELL')) || 'sh'
    shell = /\/(bash|zsh|sh|dash|ksh)$/.test(login) ? login : 'sh'
    if (!(await read($, cwdAtom))) await update($, cwdAtom, () => e.cwd)
    const list = await read($, runs)
    nextId = list.reduce((m, r) => Math.max(m, r.id), 0) + 1
    await $.command.register({ name: 'terminal', description: 'A terminal in a panel (desktop, VS Code, mobile in Remote Control)' })
    return next(e)
  })

  on('command.run', { command: 'terminal' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Terminal', focus: true })
    if (e.args?.trim()) void exec($, e.args)
    return { text: 'Terminal ouvert dans un panneau.' }
  })

  // la sortie choisie part avec le prochain message, une seule fois
  on('prompt.submit', async ($, e, next) => {
    const id = await read($, attached)
    if (id === null) return next(e)
    const run = (await read($, runs)).find(r => r.id === id)
    await update($, attached, () => null)
    if (!run) return next(e)
    const note = `Sortie d'une commande que l'utilisateur a lancée lui-même dans son terminal (dossier ${run.cwd}, code ${run.code ?? 'en cours'}):\n$ ${run.cmd}\n${run.out.slice(-20_000)}`
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Code } = t
    const list = (await read($, runs)).slice(-SHOWN_RUNS)
    const cwd = await read($, cwdAtom)
    const joined = await read($, attached)
    const now = await $.clock.now()
    const prompt = `${cwd.replace(/^\/(home|Users)\/[^/]+/, '~')} $`

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>Les commandes tournent sur la machine de la session, dans {cwd}. La sortie reste ici, sauf si tu la joins à ton prochain message.</Text>}
        {list.map((r, i) => {
          const isLast = i === list.length - 1
          const lines = r.out.split('\n')
          const tail = lines.length > SHOWN_LINES ? ['…', ...lines.slice(-SHOWN_LINES)].join('\n') : r.out
          const status = r.code === null && r.endedAt === 0
            ? `⏳ ${ago(now - r.startedAt)}`
            : r.signal ? `✗ ${r.signal}` : r.code === 0 ? `✓ ${ago(r.endedAt - r.startedAt)}` : `✗ code ${r.code}`
          return (
            <Box key={`run-${r.id}`} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color="green">{r.cwd.replace(/^\/(home|Users)\/[^/]+/, '~')} $ </Text>
                <Text bold>{r.cmd}  </Text>
                <Text dimColor>{status}  </Text>
                {r.endedAt > 0 && <Button key={`again-${r.id}`} label="↻" plain onPress={() => exec($, r.cmd)} />}
                {r.endedAt > 0 && r.out && (
                  <Button key={`join-${r.id}`} label={joined === r.id ? '📎 jointe' : '📎 joindre'} plain hotkey={isLast ? 'j' : undefined} onPress={() => attach($, r.id)} />
                )}
              </Box>
              {tail ? <Code source={tail} language="text" /> : null}
            </Box>
          )
        })}
        {busy && <Button key="stop" label="■ Stop" variant="primary" hotkey="s" onPress={() => stop($)} />}
        {e.surface !== 'mobile' && (() => {
          const { Input } = $.ui.resolve(e)
          return <Input key={`cmd-${nextId}`} label={prompt} placeholder="commande, puis Entrée" submitLabel="Lancer" autoFocus onSubmit={value => exec($, value)} />
        })()}
        {presets.length > 0 && (
          <Box flexWrap="wrap">
            {presets.map((p, i) => <Button key={`preset-${i}`} label={p} onPress={() => exec($, p)} />)}
          </Box>
        )}
      </Box>
    )
  })
}
