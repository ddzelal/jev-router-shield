// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const card = {
  paused: false,
  last: { ts: Date.now(), kind: 'human', model: 'claude-sonnet-5-5', effort: 'medium', reqModel: 'claude-opus-5-5', reqEffort: 'medium', level: 'routine', conf: 0.8, jevMs: 180, ctxK: 42, notes: ['redacted'] },
  live: { ts: Date.now(), kind: 'loop', model: 'claude-sonnet-5-5', effort: 'medium', ctxK: 44, step: 3, used: { Bash: 2, 'skill:pdf': 1 } },
  stats: { since: 0, turns: 3, tiers: { sonnet: { req: 3, tok: 9000 }, opus: { req: 1, tok: 1000 } }, downTok: 0, totalTok: 10000, costUsd: 0.42, baseUsd: 0.9 },
  today: { day: '2026-11-19', costUsd: 3.1, baseUsd: 4 },
}

test('draws the Jev card of each Claude agent from the worker', async () => {
  const host = mockHost({
    capabilities: ['agent:read', 'workspace:read'],
    results: { 'agents.list': { agents: [
      { terminalId: 't1', title: 'Smart System', agent: 'claude', state: 'working', stateStartedAt: 1, sessionId: 's1' },
      { terminalId: 't2', title: 'Codex thing', agent: 'codex', state: 'done', stateStartedAt: 1, sessionId: 's2' },
    ] } },
    requests: { 'jev.watch': ({ sessions }) => ({ router: true, cards: (sessions.includes('s1') ? { s1: card } : {}) as Record<string, typeof card> }) },
  })
  const view = await mount(panel, { host })
  const text = JSON.stringify(view.tree())
  assert.ok(text.includes('Smart System'), text)
  assert.ok(!text.includes('Codex thing'), 'non-Claude agents are left out')
  assert.ok(text.includes('Sonnet 5.5'), text)
  assert.ok(text.includes('▼ opus → sonnet'), text)
  assert.ok(text.includes('skill pdf×1'), text)
  assert.ok(text.includes('redacted for Jev'), text)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
