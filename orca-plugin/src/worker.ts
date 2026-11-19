// Reads the local jev-router-shield proxy (127.0.0.1) for the Claude Code sessions the panel shows
// and posts each change to the panel. Nothing leaves this machine.
import type { OrcaWorkerApi } from 'orca/worker'
import type { JevCard } from './protocol'

const PORTS = [4040]
let base: string | null = null
let watched = new Set<string>()
const seen = new Map<string, string>()
let timer: ReturnType<typeof setInterval> | null = null
let routerUp = false

async function findRouter(): Promise<string | null> {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ANTHROPIC_BASE_URL
  const candidates = [...(env?.startsWith('http://127.0.0.1') ? [env] : []), ...PORTS.map((p) => `http://127.0.0.1:${p}`)]
  for (const url of candidates) {
    try {
      const r = await fetch(`${url}/__jev/health`, { signal: AbortSignal.timeout(800) })
      const j = (await r.json()) as { name?: string }
      if (j?.name?.startsWith('jev-router')) return url
    } catch {}
  }
  return null
}

async function card(session: string): Promise<JevCard | null> {
  if (!base) base = await findRouter()
  if (!base) return null
  try {
    const r = await fetch(`${base}/__jev/last?session=${encodeURIComponent(session)}`, { signal: AbortSignal.timeout(1500) })
    return (await r.json()) as JevCard
  } catch {
    base = null
    return null
  }
}

async function tick(orca: OrcaWorkerApi): Promise<Record<string, JevCard>> {
  const out: Record<string, JevCard> = {}
  let up = false
  for (const s of watched) {
    const c = await card(s)
    if (!c) continue
    up = true
    out[s] = c
    const key = JSON.stringify(c)
    if (seen.get(s) !== key) {
      seen.set(s, key)
      orca.panels.post('jev.update', { router: true, session: s, card: c })
    }
  }
  if (!watched.size) up = !!(base ?? (base = await findRouter()))
  if (up !== routerUp) {
    routerUp = up
    orca.panels.post('jev.update', { router: up })
  }
  return out
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('jev.watch', async ({ sessions }) => {
    watched = new Set(sessions.filter(Boolean))
    for (const s of [...seen.keys()]) if (!watched.has(s)) seen.delete(s)
    if (timer) clearInterval(timer)
    // localhost only, cheap: the card is live while an agent works
    timer = watched.size ? setInterval(() => void tick(orca), 1500) : null
    const cards = await tick(orca)
    return { router: routerUp, cards }
  })
}
