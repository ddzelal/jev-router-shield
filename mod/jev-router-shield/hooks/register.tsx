import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, Link, Live, Pick, Stats, Today } from '../types'

// The local jev-router-shield proxy. The mod only reads its decisions; routing stays in the proxy.
// Its address is whatever ANTHROPIC_BASE_URL points to (set by `jev-router-shield setup`).
let ROUTER = 'http://127.0.0.1:4040'
const COMPACT_KEY = 'compact'
/** Context the router calls "big" (its guard, and the report's "start a fresh session" line). */
const BIG_CTX_K = 150
const BAR_CTX_K = 200

const last = atom({ plugin: 'jev-router-shield', key: 'last' } as const, null)
const live = atom({ plugin: 'jev-router-shield', key: 'live' } as const, null)
const stats = atom({ plugin: 'jev-router-shield', key: 'stats' } as const, null)
const today = atom({ plugin: 'jev-router-shield', key: 'today' } as const, null)
const paused = atom({ plugin: 'jev-router-shield', key: 'paused' } as const, false)
const link = atom({ plugin: 'jev-router-shield', key: 'link' } as const, 'off')
const compact = atom({ plugin: 'jev-router-shield', key: 'compact' } as const, false)
const EMPTY: Activity = { skills: {}, agents: {}, mcp: {}, tools: {} }
const turnAct = atom({ plugin: 'jev-router-shield', key: 'turnAct' } as const, EMPTY)
const sessAct = atom({ plugin: 'jev-router-shield', key: 'sessAct' } as const, EMPTY)

/** one use of `name` in `kind`, immutably */
export const bump = (a: Activity, kind: keyof Activity, name: string): Activity => ({
  ...a,
  [kind]: { ...a[kind], [name]: (a[kind][name] ?? 0) + 1 },
})

/** a tool call → which bucket it counts in (skills come from skill.prompt, not the Skill tool) */
export const classify = (tool: string, args: Record<string, unknown>): [keyof Activity, string] | null => {
  if (tool === 'Skill') return null
  if (tool.startsWith('mcp__')) return ['mcp', tool.split('__')[1] ?? 'mcp']
  if (tool === 'Agent' || tool === 'Task') return ['agents', String(args.subagent_type ?? 'general-purpose')]
  return ['tools', tool]
}

const top = (r: Record<string, number>, n = 6) =>
  Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => (v > 1 ? `${k}×${v}` : k))
    .join(' ')

const HANDOFF_PROMPT = `Write a handoff note so a FRESH session can continue this work without this conversation (its context has grown large, which makes every request slow and expensive).
Save it as ~/.claude/handoffs/<this project folder's name>-<YYYY-MM-DD-HHMM>.md (create the folder if needed). Contents, under ~80 lines, no secrets or keys:
- the user's language and how they like to work (preferences, rules they stated)
- goal of the work
- current state: what is done and verified, what is done but NOT verified
- decisions the user made, and constraints
- open tasks, in order, with the next step first
- key files and paths, commands to run or check
- pitfalls already hit, so they are not repeated
Then reply in the user's language with the path and one line: open a new session in this folder and type /jev-resume.`

const RESUME_PROMPT = `Continue from the newest handoff note for this project: the newest file in ~/.claude/handoffs/ whose name starts with this project folder's name. Read it, check the current state briefly (files, git status), then tell me in a few lines, in the language the note says I use, where we are and what the next step is. Do not start changing things before that.`

const isEmpty = (a: Activity) => !Object.values(a).some(r => Object.keys(r).length)

/** plain-text summary for /jev-activity */
export const describe = (a: Activity) =>
  isEmpty(a)
    ? 'nothing used yet'
    : [
        ['skills', a.skills],
        ['subagents', a.agents],
        ['MCP servers', a.mcp],
        ['tools', a.tools],
      ]
        .filter(([, r]) => Object.keys(r as Record<string, number>).length)
        .map(([k, r]) => `${k}: ${top(r as Record<string, number>, 30)}`)
        .join('\n')

const TIER_COLOR: Record<string, Color> = { haiku: 'success', sonnet: 'suggestion', opus: 'claude', fable: 'merged' }
const RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_SHORT: Record<string, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' }
const EFFORT_COLOR: Record<string, Color> = {
  low: 'success',
  medium: 'suggestion',
  high: 'warning',
  xhigh: 'error',
  max: 'error',
}

/** claude-opus-5-5 → opus */
export const tier = (model: string) => /haiku|sonnet|opus|fable/.exec(model)?.[0] ?? model

/** claude-opus-5-5 → Opus 5.5 */
export const modelName = (model: string) => {
  const m = /(haiku|sonnet|opus|fable)-(\d+)(?:-(\d+))?/.exec(model)
  if (!m) return model
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
  return `${name} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`
}

/** A meter of `width` cells for a 0–100 value. */
export const bar = (pct: number, width = 5, on = '█', off = '░') => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return on.repeat(filled) + off.repeat(width - filled)
}

/** low ▰▱▱▱▱ … max ▰▰▰▰▰ */
export const effortMeter = (effort?: string) => {
  const i = effort ? EFFORTS.indexOf(effort) : -1
  return i < 0 ? '▱▱▱▱▱' : '▰'.repeat(i + 1) + '▱'.repeat(EFFORTS.length - i - 1)
}

export const ctxColor = (k: number): Color => (k >= BIG_CTX_K ? 'error' : k >= 100 ? 'warning' : 'success')

const short = (effort?: string) => (effort ? (EFFORT_SHORT[effort] ?? effort) : '—')

/** What the router did with the turn, in a few words, and the colour to draw it in. */
export const action = (p: Pick): { text: string; color: Color } => {
  const from = tier(p.reqModel)
  const to = tier(p.model)
  switch (p.kind) {
    case 'paused':
      return { text: '⏸ routing paused · /jev to resume', color: 'warning' }
    case 'pinned':
      return { text: '📌 Fable pinned, not routed', color: 'inactive' }
    case 'trusted':
      return { text: '🔒 private project: your /model, local rules only (nothing sent to Jev)', color: 'inactive' }
    case 'fallback':
      return { text: '⚠ Jev unavailable, kept previous', color: 'warning' }
    case 'tag':
      return { text: `# tag → ${to} ${short(p.effort)}`, color: 'suggestion' }
  }
  const parts: string[] = []
  let color: Color = 'inactive'
  if (from !== to) {
    const up = (RANK[to] ?? 0) > (RANK[from] ?? 0)
    parts.push(`${up ? '▲' : '▼'} ${from} → ${to}`)
    color = up ? 'warning' : 'success'
  } else if (p.wanted && tier(p.wanted) !== to) {
    parts.push(`■ kept ${to} (ratchet)`)
  } else parts.push(`✓ ${to}`)
  if (p.notes?.includes('downgrade')) parts.push('(small ctx, cache cheap)')
  if (p.reqEffort && p.effort && p.reqEffort !== p.effort) {
    parts.push(`effort ${short(p.reqEffort)} → ${short(p.effort)}`)
    if (color === 'inactive') color = 'success'
  }
  return { text: parts.join(' · '), color }
}

/** "opus 82% · sonnet 18%" by context tokens, biggest first. */
export const mix = (s: Stats) =>
  Object.entries(s.tiers)
    .filter(([, v]) => v.tok > 0)
    .sort((a, b) => b[1].tok - a[1].tok)
    .map(([t, v]) => ({ tier: t, pct: Math.round((v.tok / Math.max(1, s.totalTok)) * 100) }))

/** Chips for the router's own rules, shown beside the decision. */
export const NOTE: Record<string, { text: string; color: Color }> = {
  redacted: { text: '🛡 redacted for Jev', color: 'suggestion' },
  risky: { text: '⚠ risky → ≥high', color: 'error' },
  inherit: { text: '↺ approval keeps previous level', color: 'suggestion' },
  escalated: { text: '⇡ effort low → med (many steps)', color: 'warning' },
}

export const usd = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

type LastReply = { paused: boolean; last: Pick | null; live: Live | null; stats: Stats | null; today: Today | null }

const fetchLast = async ($: EngineInterface, after = 0, wait = 0): Promise<LastReply | null> => {
  const s = encodeURIComponent(await $.session.id())
  try {
    const r = await $.http.fetch(`${ROUTER}/__jev/last?session=${s}&after=${after}&wait=${wait}`)
    if (!r.ok) return null
    return JSON.parse(r.text) as LastReply
  } catch {
    return null
  }
}

const apply = async ($: EngineInterface, reply: LastReply | null) => {
  await update($, link, () => (reply ? 'up' : 'down') as Link)
  if (!reply) return
  await update($, paused, () => reply.paused)
  if (reply.last) await update($, last, () => reply.last)
  if (reply.live) await update($, live, () => reply.live)
  if (reply.stats) await update($, stats, () => reply.stats)
  if (reply.today) await update($, today, () => reply.today)
}

const setPaused = async ($: EngineInterface, isPaused: boolean) => {
  const s = encodeURIComponent(await $.session.id())
  try {
    const r = await $.http.fetch(`${ROUTER}/__jev/pause?session=${s}&off=${isPaused ? 1 : 0}`, { method: 'POST' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    await update($, paused, () => isPaused)
    $.ui.toast(isPaused ? 'Jev routing paused for this session' : 'Jev routing on for this session')
  } catch (err) {
    $.ui.toast(`jev-router-shield unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const toggle = async ($: EngineInterface) => {
  const next = !(await read($, paused))
  await setPaused($, next)
  return next
}

const toggleCompact = async ($: EngineInterface) => {
  const next = !(await read($, compact))
  await update($, compact, () => next)
  await $.store.set(COMPACT_KEY, next)
}

/** find the router serving this session: ANTHROPIC_BASE_URL, else the default port if it already saw this session
 *  (Claude Code re-reads settings.json mid-session; the process env keeps the old value) */
async function discover($: EngineInterface): Promise<boolean> {
  const base = ((await $.env.get('ANTHROPIC_BASE_URL')) ?? '').replace(/\/+$/, '')
  const isOurs = async (url: string) => {
    try {
      const r = await $.http.fetch(`${url}/__jev/health`)
      return r.ok && (JSON.parse(r.text) as { name?: string }).name === 'jev-router-shield'
    } catch {
      return false
    }
  }
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base) && (await isOurs(base))) {
    ROUTER = base
    return true
  }
  if (base !== ROUTER && (await isOurs(ROUTER))) {
    const r = await fetchLast($)
    if (r && (r.last || r.live)) return true
  }
  return false
}

let registered = false
async function attach($: EngineInterface): Promise<boolean> {
  if (!(await discover($))) {
    await update($, link, () => 'off' as Link)
    return false
  }
  const stored = await $.store.get(COMPACT_KEY)
  if (typeof stored === 'boolean') await update($, compact, () => stored)
  await apply($, await fetchLast($))
  if (!registered) {
    registered = true
    await $.command.register({ name: 'jev', description: 'Pause/resume Jev model routing for this session' })
  }
  return true
}

export const register: Register = on => {
  // While a turn runs, follow every request (tool-loop steps too); a module variable, so a reload drops it.
  let ticker: Timer | null = null
  const stopTicker = () => {
    ticker?.cancel()
    ticker = null
  }

  on('session.start', async ($, e, next) => {
    await attach($)
    return next(e)
  })

  // what Claude uses, main loop and subagents alike
  on('tool.call', async ($, e, next) => {
    const c = classify(e.tool, e as unknown as Record<string, unknown>)
    if (c) {
      await update($, turnAct, a => bump(a, c[0], c[1]))
      await update($, sessAct, a => bump(a, c[0], c[1]))
    }
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await update($, turnAct, a => bump(a, 'skills', e.skill))
    await update($, sessAct, a => bump(a, 'skills', e.skill))
    return next(e)
  })

  // a big context makes every request expensive and stops Jev from moving down: hand off to a fresh session
  on('command.run', { command: 'jev-handoff' }, async $ => {
    void $.prompt.submit({ text: HANDOFF_PROMPT })
    return { text: 'Writing a handoff note for a fresh session…' }
  })

  on('command.run', { command: 'jev-resume' }, async $ => {
    void $.prompt.submit({ text: RESUME_PROMPT })
    return { text: 'Resuming from the latest handoff note…' }
  })

  on('command.run', { command: 'jev-activity' }, async $ => ({
    text: `This turn:\n${describe(await read($, turnAct))}\n\nThis session:\n${describe(await read($, sessAct))}`,
  }))

  on('command.run', { command: 'jev' }, async $ => ({
    text: `Jev routing ${(await toggle($)) ? 'paused' : 'on'} for this session.`,
  }))

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (e.text) await update($, turnAct, () => EMPTY)
    // not attached yet (router started or settings changed mid-session): look again once the turn's request went out
    if ((await read($, link)) === 'off') {
      $.clock.after(1500, () => void attach($))
      return result
    }
    stopTicker()
    if (e.text) {
      // the decision lands when the turn's first request reaches the proxy
      const since = await $.clock.now()
      $.clock.after(0, () => {
        void fetchLast($, Math.floor(since) - 2000, 15_000).then(r => apply($, r))
      })
    }
    ticker = $.clock.every(1200, () => {
      void fetchLast($).then(r => apply($, r))
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || (await read($, link)) === 'off') return result
    stopTicker()
    $.clock.after(300, () => {
      void fetchLast($).then(r => apply($, r))
    })
    return result
  })

  // Footer button beside the mode labels; hotkey j while the footer has focus.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if ((await read($, link)) === 'off') return next(e)
    const isPaused = await read($, paused)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')} </Text>}
        <Button key="jev" hotkey="j" plain dimColor={isPaused} onPress={() => toggle($)}>
          {isPaused ? '◇ Jev paused' : '◆ Jev'}
        </Button>
      </Box>
    )
  })

  // The card above the prompt: which model and effort run right now, and what Jev decided for the turn.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, link)
    if (state === 'off' || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (state === 'down') {
      return (
        <Box columnGap={2}>
          <Text inverse bold color="error">
            {' JEV '}
          </Text>
          <Text color="error" wrap="truncate-end">
            router not answering · run `jev-router-shield status`
          </Text>
        </Box>
      )
    }

    const p = await read($, last)
    const l = await read($, live)
    const s = await read($, stats)
    const day = await read($, today)
    const act = await read($, turnAct)
    if (p === null && l === null) return next(e)
    const notes = [...new Set([...(p?.notes ?? []), ...(l?.notes ?? [])])].filter(n => NOTE[n])

    // What runs now: the live request while working, else the turn's decision.
    const model = l?.model ?? p?.model ?? ''
    const effort = l?.effort ?? p?.effort
    const ctxK = l?.ctxK ?? p?.ctxK ?? 0
    const t = tier(model)
    const color = TIER_COLOR[t] ?? 'text'
    const isPaused = await read($, paused)
    const working = e.props.isWorking
    const isCompact = (await read($, compact)) || e.props.bodyColumns < 90
    const a = p ? action(p) : null

    const head = (
      <Box columnGap={2} flexShrink={0}>
        <Text inverse bold color={isPaused ? 'warning' : 'success'}>
          {isPaused ? ' JEV ⏸ ' : ' JEV '}
        </Text>
        <Text bold color={color}>
          ● {modelName(model)}
        </Text>
        <Text>
          <Text dimColor>effort </Text>
          <Text color={EFFORT_COLOR[effort ?? ''] ?? 'inactive'}>{effortMeter(effort)}</Text>
          <Text bold> {short(effort)}</Text>
        </Text>
        <Text>
          <Text dimColor>ctx </Text>
          <Text color={ctxColor(ctxK)}>{bar((ctxK / BAR_CTX_K) * 100, 8, '▰', '▱')}</Text>
          <Text bold color={ctxColor(ctxK)}>
            {' '}
            {ctxK}k
          </Text>
        </Text>
      </Box>
    )

    const status = working ? (
      <Text color="claude">⟳ working{l && l.step > 1 ? ` · step ${l.step}` : ''}</Text>
    ) : (
      <Text dimColor>○ idle</Text>
    )

    if (isCompact) {
      return (
        <Box columnGap={2}>
          {head}
          {a && (
            <Text color={a.color} wrap="truncate-end">
              {a.text}
            </Text>
          )}
          {notes.map(n => (
            <Text key={n} color={NOTE[n]!.color} wrap="truncate-end">
              {NOTE[n]!.text}
            </Text>
          ))}
          <Button key="expand" plain dimColor onPress={() => toggleCompact($)}>
            ▾
          </Button>
        </Box>
      )
    }

    const tiers = s ? mix(s) : []
    const downPct = s && s.totalTok > 0 ? Math.round((s.downTok / s.totalTok) * 100) : 0

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box justifyContent="space-between">
          {head}
          <Box columnGap={2} flexShrink={0}>
            {status}
            <Button key="collapse" plain dimColor onPress={() => toggleCompact($)}>
              ▴
            </Button>
          </Box>
        </Box>
        <Box columnGap={2}>
          {p?.level !== undefined ? (
            <Text wrap="truncate-end">
              <Text dimColor>Jev </Text>
              <Text bold>{p.level}</Text>
              <Text dimColor> {bar(p.conf ?? 0, 5)} </Text>
              <Text>{p.conf ?? 0}%</Text>
              {p.wanted && tier(p.wanted) !== tier(p.model) && <Text dimColor> → wants {tier(p.wanted)}</Text>}
            </Text>
          ) : (
            <Text dimColor>Jev —</Text>
          )}
          {a && (
            <Text color={a.color} wrap="truncate-end">
              {a.text}
            </Text>
          )}
          {notes.map(n => (
            <Text key={n} color={NOTE[n]!.color} wrap="truncate-end">
              {NOTE[n]!.text}
            </Text>
          ))}
          {ctxK >= BIG_CTX_K && !working && <Text color="warning">↻ big context: /jev-handoff</Text>}
          {p?.jevMs !== undefined && <Text dimColor>{p.jevMs}ms</Text>}
          {s && s.turns > 0 && (
            <Text wrap="truncate-end">
              <Text dimColor>│ session {s.turns} turns </Text>
              {tiers.map(x => (
                <Text key={x.tier} color={TIER_COLOR[x.tier] ?? 'text'}>
                  {' '}
                  {x.tier} {x.pct}%
                </Text>
              ))}
              {downPct > 0 && <Text color="success"> · ↓{downPct}% on cheaper</Text>}
            </Text>
          )}
        </Box>
        {!isEmpty(act) && (
          <Text wrap="truncate-end">
            <Text dimColor>used </Text>
            {Object.keys(act.skills).length > 0 && (
              <Text>
                <Text color="claude">skill </Text>
                <Text bold>{top(act.skills)}</Text>
                <Text dimColor>{'  '}</Text>
              </Text>
            )}
            {Object.keys(act.agents).length > 0 && (
              <Text>
                <Text color="suggestion">agents </Text>
                <Text bold>{top(act.agents)}</Text>
                <Text dimColor>{'  '}</Text>
              </Text>
            )}
            {Object.keys(act.mcp).length > 0 && (
              <Text>
                <Text color="merged">MCP </Text>
                <Text bold>{top(act.mcp)}</Text>
                <Text dimColor>{'  '}</Text>
              </Text>
            )}
            {Object.keys(act.tools).length > 0 && <Text dimColor>{top(act.tools)}</Text>}
          </Text>
        )}
        {(s || day) && (
          <Box columnGap={2}>
            <Text dimColor>API-price equivalent</Text>
            {s && (
              <Text>
                <Text dimColor>session </Text>
                <Text bold>{usd(s.costUsd)}</Text>
                {s.baseUsd - s.costUsd >= 0.005 && <Text color="success"> saved {usd(s.baseUsd - s.costUsd)}</Text>}
              </Text>
            )}
            {day && (
              <Text>
                <Text dimColor>today </Text>
                <Text bold>{usd(day.costUsd)}</Text>
                {day.baseUsd - day.costUsd >= 0.005 && <Text color="success"> saved {usd(day.baseUsd - day.costUsd)}</Text>}
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
