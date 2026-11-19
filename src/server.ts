import { appendFile, mkdir } from "fs/promises";
import { DIR, LOG, NAME, loadConfig, loadKey } from "./config";
import { usedIn } from "./usage";
import { applyDecision, decide, paused, type Decision } from "./route";

const cfg = loadConfig();
const key = loadKey();
await mkdir(DIR, { recursive: true });
if (!key) console.error("[jev-router-shield] no TYPESAFE_API_KEY: running as pass-through");

const HOP = ["host", "content-length", "connection", "accept-encoding"];

function upstreamHeaders(req: Request): Headers {
  const h = new Headers(req.headers);
  for (const k of HOP) h.delete(k);
  h.set("accept-encoding", "identity");
  return h;
}

function clientHeaders(r: Response): Headers {
  const h = new Headers(r.headers);
  h.delete("content-encoding"); // Bun already decoded the body
  h.delete("content-length");
  h.set("x-jev-router-shield", "1");
  return h;
}

/** the last per-turn decision of each session, for the Claude Code mod (jev-router-shield) */
interface Last {
  ts: number; kind: string; model: string; effort?: string; reqModel: string; reqEffort?: string; wanted?: string;
  level?: string; conf?: number; probs?: Record<string, number>; jevMs?: number; ctxK: number;
  risky?: number; notes?: string[];
}
const lastBySession = new Map<string, Last>();

/** the request in flight / last sent for a session, tool-loop steps included */
interface Live { ts: number; kind: string; model: string; effort?: string; ctxK: number; step: number; notes?: string[]; turnStart?: number; used?: Record<string, number> }
const liveBySession = new Map<string, Live>();

/** per-session totals since the proxy started: requests and context tokens per model tier */
interface Stats {
  since: number; turns: number; tiers: Record<string, { req: number; tok: number }>; downTok: number; totalTok: number;
  /** API-list-price equivalent of what was sent, and of the same requests on the model Claude Code asked for */
  costUsd: number; baseUsd: number;
}
/** the same two sums for today, over all sessions (rebuilt from the log at start) */
const today = { day: new Date().toISOString().slice(0, 10), costUsd: 0, baseUsd: 0 };

/** $ for one request at `tier` prices; `cacheHit` turns cache writes into reads (staying on the warm model) */
function priceOf(tier: string, u: any, cacheHit = false): number {
  const p = cfg.prices[tier];
  if (!p) return 0;
  const [inp, out, read] = p;
  const write = u.cache_creation_input_tokens ?? 0, rd = u.cache_read_input_tokens ?? 0;
  return ((u.input_tokens ?? 0) * inp + (cacheHit ? (write + rd) * read : write * inp * 2 + rd * read) + (u.output_tokens ?? 0) * out) / 1e6;
}
const statsBySession = new Map<string, Stats>();
const tierOf = (m: string) => /haiku|sonnet|opus|fable/.exec(m)?.[0] ?? m;
const TIER_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

function rebuildToday() {
  try {
    const text = require("fs").readFileSync(LOG, "utf8") as string;
    for (const line of text.split("\n")) {
      if (!line.includes(`"ts":"${today.day}`)) continue;
      const r = JSON.parse(line);
      if (r.kind === "background" || !r.ctx || r.status >= 400) continue;
      const u = { input_tokens: r.ctx - (r.cacheRead ?? 0) - (r.cacheWrite ?? 0), cache_read_input_tokens: r.cacheRead ?? 0, cache_creation_input_tokens: r.cacheWrite ?? 0, output_tokens: r.out ?? 0 };
      const sent = tierOf(String(r.sent).split("/")[0]), req = tierOf(String(r.req).split("/")[0]);
      const c = priceOf(sent, u);
      today.costUsd += c; today.baseUsd += sent === req ? c : priceOf(req, u, true);
    }
  } catch {}
}

/** adds the request to the session and today totals; returns its API-list-price cost */
function account(d: Decision, ctx: number, usage: any): number | undefined {
  if (!d.session || d.kind === "background") return priceOf(tierOf(d.model), usage);
  const st = statsBySession.get(d.session) ?? { since: Date.now(), turns: 0, tiers: {}, downTok: 0, totalTok: 0, costUsd: 0, baseUsd: 0 };
  const sentTier = tierOf(d.model), reqTier = tierOf(d.reqModel);
  const cost = priceOf(sentTier, usage);
  const base = sentTier === reqTier ? cost : priceOf(reqTier, usage, true);
  st.costUsd += cost; st.baseUsd += base;
  const day = new Date().toISOString().slice(0, 10);
  if (today.day !== day) Object.assign(today, { day, costUsd: 0, baseUsd: 0 });
  today.costUsd += cost; today.baseUsd += base;
  const t = tierOf(d.model);
  const row = (st.tiers[t] ??= { req: 0, tok: 0 });
  row.req++; row.tok += ctx; st.totalTok += ctx;
  if ((TIER_RANK[t] ?? 0) < (TIER_RANK[tierOf(d.reqModel)] ?? 0)) st.downTok += ctx;
  if (d.preview !== undefined) st.turns++;
  statsBySession.set(d.session, st);
  return cost;
}
const waiters = new Map<string, Set<() => void>>();
/** P(the task needs at most `level`): what the router actually thresholds on */
const ORDER = ["trivial", "routine", "substantial", "hard", "extreme"];
const cumulative = (probs: Record<string, number>, level: string) =>
  Math.round(ORDER.slice(0, ORDER.indexOf(level) + 1).reduce((a, l) => a + (probs[l] ?? 0), 0) * 100);

function remember(d: Decision) {
  if (!d.session) return;
  if (d.kind !== "background") {
    const prevLive = liveBySession.get(d.session);
    const step = d.preview !== undefined ? 1 : (prevLive?.step ?? 0) + 1;
    // keep a note (e.g. "escalated") visible for the rest of the turn
    const notes = d.preview !== undefined ? d.notes : [...new Set([...(prevLive?.notes ?? []), ...(d.notes ?? [])])];
    // what Claude used this turn (skills, agents, MCP, tools), counted per request step
    const used: Record<string, number> = d.preview !== undefined ? {} : { ...(prevLive?.used ?? {}) };
    for (const u of d.used ?? []) used[u] = (used[u] ?? 0) + 1;
    const turnStart = d.preview !== undefined ? Date.now() : (prevLive?.turnStart ?? Date.now());
    liveBySession.set(d.session, { ts: Date.now(), kind: d.kind, model: d.model, effort: d.effort, ctxK: Math.round(d.estTokens / 1000), step, notes, turnStart, used });
  }
  // a new human turn carries a preview; paused/pinned have none but are worth showing
  const turn = d.preview !== undefined || d.kind === "paused" || d.kind === "pinned";
  if (!turn) return;
  const prev = lastBySession.get(d.session);
  // paused/pinned fire on every request; only record them once per change
  if ((d.kind === "paused" || d.kind === "pinned") && prev?.kind === d.kind && prev.model === d.model) return;
  lastBySession.set(d.session, {
    ts: Date.now(), kind: d.kind, model: d.model, effort: d.effort, reqModel: d.reqModel, reqEffort: d.reqEffort, wanted: d.wanted,
    level: d.level, conf: d.level && d.probs ? cumulative(d.probs, d.level) : undefined,
    probs: d.probs, jevMs: d.jevMs, ctxK: Math.round(d.estTokens / 1000), risky: d.risky, notes: d.notes,
  });
  const w = waiters.get(d.session);
  if (w) { waiters.delete(d.session); for (const f of w) f(); }
}

/** GET /__jev/last?session=…&after=ms  — long-polls up to `wait` ms for a decision newer than `after` */
async function lastFor(url: URL): Promise<Response> {
  const s = url.searchParams.get("session") ?? "";
  const after = Number(url.searchParams.get("after") ?? 0);
  const wait = Math.min(Number(url.searchParams.get("wait") ?? 0), 20_000);
  const cur = () => lastBySession.get(s);
  if (wait > 0 && !((cur()?.ts ?? 0) > after)) {
    await new Promise<void>((res) => {
      const set = waiters.get(s) ?? new Set();
      const t = setTimeout(() => { set.delete(done); res(); }, wait);
      const done = () => { clearTimeout(t); res(); };
      set.add(done); waiters.set(s, set);
    });
  }
  return Response.json({ paused: paused.has(s), last: cur() ?? null, live: liveBySession.get(s) ?? null, stats: statsBySession.get(s) ?? null, today });
}

function log(rec: object) {
  appendFile(LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n").catch(() => {});
}

/** read usage from the SSE stream without delaying it */
async function sniffUsage(stream: ReadableStream<Uint8Array>, d: Decision, status: number, retried: boolean) {
  const dec = new TextDecoder();
  let buf = "", usage: any = {}, out = 0;
  try {
    for await (const chunk of stream as any) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("data: ")) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "message_start") usage = ev.message?.usage ?? {};
          if (ev.type === "message_delta" && ev.usage?.output_tokens) out = ev.usage.output_tokens;
        } catch {}
      }
    }
  } catch {}
  const ctx = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const usd = status < 400 ? account(d, ctx, { ...usage, output_tokens: out }) : undefined;
  if (d.session && ctx) { const l = liveBySession.get(d.session); if (l) l.ctxK = Math.round(ctx / 1000); }
  log({
    kind: d.kind, cwd: d.cwd?.replace(/^\/Users\/[^/]+/, "~"), thread: d.thread.slice(-14), status, retried,
    req: `${d.reqModel}/${d.reqEffort ?? "-"}`, sent: `${d.model}/${d.effort ?? "-"}`, level: d.level, probs: d.probs, jevMs: d.jevMs,
    risky: d.risky, notes: d.notes?.length ? d.notes : undefined,
    ctx: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens, out, turn: d.preview !== undefined || undefined,
    usd: usd ? Math.round(usd * 1e5) / 1e5 : undefined, used: d.used,
  });
}

Bun.serve({
  port: Number(process.env.JEV_PORT) || cfg.port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__jev/health") return Response.json({ ok: true, name: NAME, jev: !!key });
    if (url.pathname === "/__jev/last") return lastFor(url);
    if (url.pathname === "/__jev/sessions") return Response.json([...lastBySession.entries()].map(([s, l]) => ({ session: s, ts: l.ts, kind: l.kind })));
    if (url.pathname === "/__jev/pause" && req.method === "POST") {
      const s = url.searchParams.get("session") ?? "";
      if (!s) return Response.json({ error: "session required" }, { status: 400 });
      if (url.searchParams.get("off") === "0") paused.delete(s); else paused.add(s);
      return Response.json({ paused: paused.has(s) });
    }
    const target = cfg.upstream + url.pathname + url.search;
    const headers = upstreamHeaders(req);

    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      const r = await fetch(target, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer() });
      return new Response(r.body, { status: r.status, headers: clientHeaders(r) });
    }

    const raw = await req.text();
    let body: any;
    try { body = JSON.parse(raw); } catch {
      const r = await fetch(target, { method: "POST", headers, body: raw });
      return new Response(r.body, { status: r.status, headers: clientHeaders(r) });
    }

    let d: Decision;
    try { d = await decide(cfg, key, body, req.headers.get("x-claude-code-session-id"), raw); }
    catch (e) { console.error("[jev-router-shield] decide failed", e); d = { thread: "err", kind: "fallback", reqModel: body.model, model: body.model, estTokens: 0 }; }

    try { const u = usedIn(body); if (u.length) d.used = u; } catch {}
    remember(d);
    const changed = d.model !== body.model || d.effort !== body.output_config?.effort;
    let r = await fetch(target, { method: "POST", headers, body: changed ? JSON.stringify(applyDecision(body, d)) : raw });
    let retried = false;
    // safety net: if the rewritten request is rejected, send the original untouched
    if (changed && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
      console.error("[jev-router-shield] upstream", r.status, "for", d.model, "→ retry original:", (await r.text()).slice(0, 300));
      r = await fetch(target, { method: "POST", headers, body: raw });
      retried = true;
      d = { ...d, model: body.model, effort: body.output_config?.effort };
    }
    if (!r.body) return new Response(null, { status: r.status, headers: clientHeaders(r) });
    const [a, b] = r.body.tee();
    sniffUsage(b, d, r.status, retried);
    return new Response(a, { status: r.status, headers: clientHeaders(r) });
  },
});

console.log(`[jev-router-shield] listening on http://127.0.0.1:${Number(process.env.JEV_PORT) || cfg.port} → ${cfg.upstream} (jev: ${key ? "on" : "off"})`);

rebuildToday();

// drop per-session UI state a day after its last request
setInterval(() => {
  const cut = Date.now() - 24 * 3600_000;
  for (const [s, l] of liveBySession) if (l.ts < cut) { liveBySession.delete(s); lastBySession.delete(s); statsBySession.delete(s); }
}, 600_000).unref?.();
