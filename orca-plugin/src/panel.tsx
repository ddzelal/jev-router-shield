// The Jev card for every Claude Code agent of the focused workspace, chat or terminal.
// Same data as the card above the prompt in the terminal; read from the local router by the worker.
import {
  atom, Badge, Box, Callout, EmptyState, host, on, plugin, Progress, read, RelativeTime, Row, set, Stack, Text, update,
  type PanelContext,
} from 'orca'
import type { JevCard } from './protocol'

type Agent = { terminalId: string | null; title: string | null; agent: string | null; state: string; sessionId?: string | null }
type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const agents = atom<Agent[]>([])
const cards = atom<Record<string, JevCard>>({})
const router = atom<boolean | null>(null)

const tier = (m?: string) => /fable|opus|sonnet|haiku/.exec(m ?? '')?.[0] ?? (m ?? '?')
const NAME: Record<string, string> = { fable: 'Fable 5.2', opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5' }
const TONE: Record<string, Tone> = { fable: 'accent', opus: 'warning', sonnet: 'success', haiku: 'neutral' }
const RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }
const EFF = ['low', 'medium', 'high', 'xhigh', 'max']
const short = (e?: string) => (e === 'medium' ? 'med' : (e ?? '-'))
const usd = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)
const NOTE: Record<string, { text: string; tone: Tone }> = {
  redacted: { text: '🛡 redacted for Jev', tone: 'accent' },
  risky: { text: '⚠ risky → ≥high', tone: 'danger' },
  inherit: { text: '↺ approval keeps level', tone: 'accent' },
  escalated: { text: '⇡ effort low → med', tone: 'warning' },
}

function action(p: NonNullable<JevCard['last']>): { text: string; tone: Tone } {
  switch (p.kind) {
    case 'paused': return { text: '⏸ routing paused', tone: 'warning' }
    case 'pinned': return { text: '📌 Fable pinned, not routed', tone: 'neutral' }
    case 'trusted': return { text: '🔒 private project: nothing sent to Jev', tone: 'neutral' }
    case 'fallback': return { text: '⚠ Jev unavailable, kept previous', tone: 'warning' }
    case 'tag': return { text: `# tag → ${tier(p.model)} ${short(p.effort)}`, tone: 'accent' }
  }
  const from = tier(p.reqModel), to = tier(p.model)
  const parts: string[] = []
  let tone: Tone = 'neutral'
  if (from !== to) {
    const up = (RANK[to] ?? 0) > (RANK[from] ?? 0)
    parts.push(`${up ? '▲' : '▼'} ${from} → ${to}`)
    tone = up ? 'warning' : 'success'
  } else if (p.wanted && tier(p.wanted) !== to) parts.push(`■ kept ${to} (ratchet)`)
  else parts.push(`✓ ${to}`)
  if (p.reqEffort && p.effort && p.reqEffort !== p.effort) parts.push(`effort ${short(p.reqEffort)} → ${short(p.effort)}`)
  return { text: parts.join(' · '), tone }
}

function usedLine(used?: Record<string, number>): string {
  const e = Object.entries(used ?? {})
  if (!e.length) return ''
  const label = (k: string) => k.replace(/^skill:/, 'skill ').replace(/^agent:/, 'agent ').replace(/^mcp:/, 'MCP ').replace(/^cmd:/, '/')
  const order = (k: string) => (k.startsWith('skill:') ? 0 : k.startsWith('agent:') ? 1 : k.startsWith('mcp:') ? 2 : k.startsWith('cmd:') ? 3 : 4)
  return e.sort((a, b) => order(a[0]) - order(b[0]) || b[1] - a[1]).slice(0, 10).map(([k, n]) => `${label(k)}×${n}`).join('  ')
}

async function refresh(): Promise<void> {
  try {
    const r = await host.call('agents.list')
    const list = (r.agents as Agent[]).filter((a) => !a.agent || /claude/i.test(a.agent))
    set(agents, list)
    const sessions = list.map((a) => a.sessionId).filter((s): s is string => !!s)
    const res = await plugin.request('jev.watch', { sessions })
    set(router, res.router)
    set(cards, res.cards)
  } catch {
    set(router, false)
  }
}

export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(on('workspace.changed', () => void refresh()))
  ctx.subscriptions.push(
    on('agent.status.changed', (e) => {
      const known = read(agents).some((a) => a.sessionId && a.sessionId === e.sessionId)
      if (!known) return void refresh()
      update(agents, (xs) => xs.map((a) => (a.sessionId === e.sessionId ? { ...a, state: e.state, title: e.title ?? a.title } : a)))
    }),
  )
  ctx.subscriptions.push(
    plugin.on('jev.update', (u) => {
      set(router, u.router)
      if (u.session && u.card) update(cards, (c) => ({ ...c, [u.session as string]: u.card as JevCard }))
    }),
  )
  void refresh()
  return () => void plugin.request('jev.watch', { sessions: [] }).catch(() => {})
}

function AgentCard({ a }: { a: Agent }) {
  const c = a.sessionId ? read(cards)[a.sessionId] : undefined
  const title = a.title || 'Claude'
  const working = a.state === 'working'
  if (!c || (!c.last && !c.live)) {
    return (
      <Box border radius="md" padding="sm" direction="column" gap="xs">
        <Text weight="semibold" truncate>{title}</Text>
        <Text muted size="xs">no request through Jev yet in this session</Text>
      </Box>
    )
  }
  const live = c.live, last = c.last, s = c.stats
  const model = tier(live?.model ?? last?.model)
  const eff = live?.effort ?? last?.effort
  const ctxK = live?.ctxK ?? last?.ctxK ?? 0
  const ctxTone: Tone = ctxK >= 150 ? 'danger' : ctxK >= 100 ? 'warning' : 'success'
  const notes = [...new Set([...(last?.notes ?? []), ...(live?.notes ?? [])])].filter((n) => NOTE[n])
  const act = last ? action(last) : null
  const total = s ? Object.values(s.tiers).reduce((x, t) => x + t.tok, 0) : 0
  const mix = s && total ? Object.entries(s.tiers).sort((x, y) => y[1].tok - x[1].tok).map(([k, t]) => `${k} ${Math.round((t.tok / total) * 100)}%`).join(' · ') : ''
  const used = usedLine(live?.used)
  return (
    <Box border={working ? 'accent' : true} radius="md" padding="sm" direction="column" gap="xs">
      <Row justify="between" gap="xs">
        <Text weight="semibold" truncate>{title}</Text>
        {c.paused ? <Badge tone="warning">paused</Badge> : working ? <Badge tone="accent">⟳ working · step {live?.step ?? 1}</Badge> : <Badge>idle</Badge>}
      </Row>
      <Row gap="xs" wrap>
        <Badge tone={TONE[model] ?? 'neutral'}>● {NAME[model] ?? model}</Badge>
        <Badge>effort {short(eff)} {eff ? `${EFF.indexOf(eff) + 1}/5` : ''}</Badge>
        <Badge tone={ctxTone}>ctx {ctxK}k</Badge>
      </Row>
      <Progress label={`context ${ctxK}k of 200k`} labelHidden value={Math.min(100, Math.round((ctxK / 200) * 100))} />
      {last?.level ? (
        <Text size="xs">
          Jev <Text weight="semibold">{last.level}</Text>{last.conf !== undefined ? ` ${Math.round(last.conf * 100)}%` : ''}
          {last.wanted && tier(last.wanted) !== tier(last.model) ? ` → wants ${tier(last.wanted)}` : ''}
          {last.jevMs ? `  ${last.jevMs}ms` : ''}
        </Text>
      ) : null}
      {act ? <Text size="xs" tone={act.tone}>{act.text}</Text> : null}
      {notes.length ? (
        <Row gap="xs" wrap>{notes.map((n) => <Badge tone={NOTE[n].tone}>{NOTE[n].text}</Badge>)}</Row>
      ) : null}
      {used ? <Text size="xs" muted>used {used}</Text> : null}
      {mix ? <Text size="xs" muted>session {mix}</Text> : null}
      {s ? (
        <Text size="xs">
          ≈ <Text weight="semibold">{usd(s.costUsd)}</Text> this session
          {s.baseUsd - s.costUsd >= 0.005 ? <Text tone="success">{` · saved ${usd(s.baseUsd - s.costUsd)}`}</Text> : null}
        </Text>
      ) : null}
      {ctxK >= 150 && !working ? <Callout tone="warning" title="Big context">Ask the agent for a handoff note, then continue in a fresh session.</Callout> : null}
      {last ? <Text size="xs" muted>last decision <RelativeTime at={last.ts} muted /></Text> : null}
    </Box>
  )
}

export default function Panel() {
  const up = read(router)
  const list = read(agents)
  const today = Object.values(read(cards)).find((c) => c.today)?.today
  return (
    <Stack gap="sm">
      <Row justify="between">
        <Text weight="semibold">JEV</Text>
        {today ? <Text size="xs" muted>today ≈ {usd(today.costUsd)}{today.baseUsd - today.costUsd >= 0.005 ? ` · saved ${usd(today.baseUsd - today.costUsd)}` : ''}</Text> : null}
      </Row>
      {up === false ? (
        <Callout tone="warning" title="Router not running">Start it with: jev-router-shield restart</Callout>
      ) : null}
      {list.length === 0 ? (
        <EmptyState title="No Claude agents here" description="Open Claude (chat or terminal) in this workspace." icon="agent" />
      ) : (
        list.map((a) => <AgentCard a={a} />)
      )}
      <Text size="xs" muted>API list-price equivalent · data from your local router only</Text>
    </Stack>
  )
}
