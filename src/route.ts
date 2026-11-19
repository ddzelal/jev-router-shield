import type { Config, Level } from "./config";
import { askJev } from "./jev";
import { PASSWORD_WORDS, redactStrict, turnShape } from "./redact";
import { buildVocab, type Vocab } from "./vocab";
import { appendFile } from "fs/promises";
import { join } from "path";
import { DIR } from "./config";

/** every state sent to Jev from a redacted project is kept locally for audit (`jev-router-shield sent`) */
export const SENT_LOG = join(DIR, "sent.jsonl");

const ORDER: Level[] = ["trivial", "routine", "substantial", "hard", "extreme"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const maxEffort = (a?: string, b?: string) => (EFFORTS.indexOf(a ?? "") >= EFFORTS.indexOf(b ?? "") ? a : b);

/** local risk words (English; add your language via config.riskyWords): a backup for Jev, and the only signal in trusted projects */
const RISKY_BASE = String.raw`prod(uction)?|deploy\w*|release|rollback|migrat\w*|drop\s+(table|database)|truncate|rm\s+-rf|force[- ]push|delete\w*|credential\w*|secret|billing`;
let riskyRe: { src: string; re: RegExp } | null = null;
const riskyWords = (cfg: Config) => {
  const src = [RISKY_BASE, ...cfg.riskyWords].join("|");
  if (riskyRe?.src !== src) riskyRe = { src, re: new RegExp(`(?<![\\p{L}\\d])(${src})(?![\\p{L}\\d])`, "iu") };
  return riskyRe.re;
};
/** company-project match; cwd + "/" so "~/work" matches "/work/" too */
export const isCompany = (cfg: Config, p: string) => [...cfg.redacted, ...cfg.trusted].some((t) => (p + "/").includes(t));

let vocab: { v: Vocab; at: number } | null = null;
export function getVocab(cfg: Config): Vocab {
  if (!vocab || Date.now() - vocab.at > 24 * 3600_000) {
    vocab = { v: buildVocab((p) => isCompany(cfg, p), cfg.extraWords), at: Date.now() };
    console.log(`[jev-router-shield] vocab: ${vocab.v.known.size} known words (${vocab.v.learned} learned from your non-company prompts)`);
  }
  return vocab.v;
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

interface Thread {
  model: string; // current (ratcheted) model
  effort: string;
  level: Level | "pass";
  lastHuman: string; // hash of last decided human message
  seen: number;
  steps: number; // tool-loop steps since the last human message
}
const threads = new Map<string, Thread>();
/** sessions where routing is paused from the UI (/jev); requests pass through untouched */
export const paused = new Set<string>();

export interface Decision {
  /** tools/skills/agents/MCP servers used in the step this request answers (src/usage.ts) */
  used?: string[];
  thread: string;
  cwd?: string;
  kind: "human" | "loop" | "background" | "trusted" | "tag" | "fallback" | "unknown" | "paused" | "pinned";
  session?: string;
  /** model the Jev level asked for, before the ratchet / big-context guard */
  wanted?: string;
  reqModel: string;
  reqEffort?: string;
  model: string;
  effort?: string;
  level?: string;
  probs?: Record<string, number>;
  jevMs?: number;
  risky?: number;
  /** why the router deviated from the plain Jev level: inherit | risky | escalated | downgrade | redacted */
  notes?: string[];
  estTokens: number;
  preview?: string;
}

const hash = (s: string) => Bun.hash(s).toString(36);

function textOf(content: any): { text: string; toolResult: boolean } {
  if (typeof content === "string") return { text: content, toolResult: false };
  if (!Array.isArray(content)) return { text: "", toolResult: false };
  let toolResult = false;
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "tool_result") toolResult = true;
    else if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return { text: parts.join("\n"), toolResult };
}

/** remove harness-injected blocks, keep what the human typed */
export function cleanHuman(t: string): string {
  return t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(command-[\w-]+|local-command-[\w-]+)>[\s\S]*?<\/\1>/g, "")
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_, p) => `[pasted ${p.length} chars] ${p.slice(0, 300)}`)
    .trim();
}

export function scrub(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, (m) => `[code block, ${m.split("\n").length} lines]`)
    .replace(/\b(sk|pk|rk|ghp|gho|xox[bap]|apikey|AKIA)[-_A-Za-z0-9]{12,}/g, "[secret]")
    .replace(/(?<![\p{L}\d])(bearer|token|secret|api[_-]?key|key|password|passwd|pwd)\s*[:=]\s*\S+/giu, "$1 [secret]")
    .replace(new RegExp(`(?<![\\p{L}\\d])(${PASSWORD_WORDS})\\s+\\p{L}{1,6}\\s+\\S+`, "giu"), "$1 [secret]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[ip]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[secret]");
}

/** the env block can sit in `system` or in a role:"system" message; search the raw JSON (last match = current cwd) */
function findCwd(raw: string): string | undefined {
  const all = [...raw.matchAll(/Primary working directory: ([^\\"\s]+)/g)];
  return all.at(-1)?.[1];
}

function tagOverride(t: string): { model?: string; effort?: string; off?: boolean } | null {
  const m = t.match(/(^|\s)#(fast|sonnet|opus|max|nojev|fable)\b/i);
  if (!m) return null;
  switch (m[2].toLowerCase()) {
    case "fast": return { model: "claude-sonnet-5-5", effort: "low" };
    case "sonnet": return { model: "claude-sonnet-5-5", effort: "medium" };
    case "opus": return { model: "claude-opus-5-5", effort: "high" };
    case "max": return { model: "claude-opus-5-5", effort: "xhigh" };
    case "fable": return { model: "claude-fable-5-2" };
    default: return { off: true };
  }
}

export async function decide(cfg: Config, key: string | undefined, body: any, sessionHeader: string | null, raw: string): Promise<Decision> {
  const reqModel = String(body.model ?? "");
  const reqEffort = body.output_config?.effort;
  const estTokens = Math.round(raw.length / 4);
  const msgs: any[] = Array.isArray(body.messages) ? body.messages : [];
  const thread = `${sessionHeader ?? "nosess"}:${hash(textOf(msgs[0]?.content).text.slice(0, 600))}`;
  const cwd = findCwd(raw);
  const base: Decision = { thread, session: sessionHeader ?? undefined, cwd, kind: "unknown", reqModel, reqEffort, model: reqModel, effort: reqEffort, estTokens };
  if (sessionHeader && paused.has(sessionHeader)) return { ...base, kind: "paused" };
  const rank = (m: string) => cfg.modelRank[m] ?? 0;

  // background / small-model calls (titles, summaries): leave alone
  if (!(reqModel in cfg.modelRank) || reqModel.includes("haiku")) return { ...base, kind: "background" };
  // Fable is always a deliberate choice: never re-route it
  if (reqModel.includes("fable")) return { ...base, kind: "pinned" };

  // last conversational message decides if this is a fresh human turn
  const last = [...msgs].reverse().find((m) => m.role === "user" || m.role === "assistant");
  const lt = last?.role === "user" ? textOf(last.content) : { text: "", toolResult: true };
  const human = last?.role === "user" && !lt.toolResult ? cleanHuman(lt.text) : "";

  const now = Date.now();
  let th = threads.get(thread);
  if (th && now - th.seen > cfg.idleResetMin * 60_000 && estTokens < cfg.bigContextTokens) th = undefined;

  const finish = (d: Decision): Decision => {
    // guard: a big context never goes to a smaller model than the client asked for
    if (estTokens > cfg.bigContextTokens && rank(d.model) < rank(reqModel)) d.model = reqModel;
    return d;
  };

  if (!human) {
    // tool loop / continuation: reuse the thread's choice
    if (!th) {
      threads.set(thread, { model: reqModel, effort: reqEffort, level: "pass", lastHuman: "", seen: now, steps: 0 });
      return { ...base, kind: "unknown" };
    }
    th.seen = now;
    th.steps++;
    const notes: string[] = [];
    // a "low" turn that keeps calling tools is real work: lift it (effort changes keep the prompt cache)
    if (th.level !== "pass" && th.effort === "low" && th.steps >= cfg.lowEscalateSteps) {
      th.effort = "medium";
      notes.push("escalated");
    }
    return finish({ ...base, kind: "loop", model: th.model, effort: th.effort, level: th.level, notes });
  }

  const h = hash(human);
  if (th && th.lastHuman === h) {
    th.seen = now; // retry of the same turn
    return finish({ ...base, kind: "loop", model: th.model, effort: th.effort, level: th.level });
  }
  const preview = scrub(human).replace(/\s+/g, " ").slice(0, 90);

  const tag = tagOverride(human);
  if (tag) {
    const model = tag.off ? reqModel : tag.model ?? reqModel;
    const effort = tag.off ? reqEffort : tag.effort ?? reqEffort;
    threads.set(thread, { model, effort, level: "pass", lastHuman: h, seen: now, steps: 0 });
    return { ...base, kind: "tag", model, effort, preview };
  }

  if (!cwd || cfg.trusted.some((t) => (cwd + "/").includes(t)) || !key) {
    // local rules only: keep the model you picked, lift effort for risky work, inherit it for short approvals
    const notes: string[] = [];
    let effort = reqEffort;
    if (riskyWords(cfg).test(human)) { effort = maxEffort(effort, "high"); notes.push("risky"); }
    if (th && words(human) <= cfg.shortReplyWords && EFFORTS.indexOf(th.effort ?? "") > EFFORTS.indexOf(effort ?? "")) {
      effort = th.effort; notes.push("inherit");
    }
    threads.set(thread, { model: reqModel, effort, level: "pass", lastHuman: h, seen: now, steps: 0 });
    return { ...base, kind: key ? "trusted" : "fallback", effort, notes, preview };
  }

  const isRedacted = cfg.redacted.some((t) => (cwd + "/").includes(t));
  // build Jev state: this message + a bit of context for short replies
  const prevHuman = [...msgs].slice(0, -1).reverse()
    .filter((m) => m.role === "user").map((m) => textOf(m.content)).find((t) => !t.toolResult && cleanHuman(t.text));
  const prevAsst = [...msgs].reverse().find((m) => m.role === "assistant");
  let state = `LATEST MESSAGE:\n${scrub(human).slice(0, 2500)}`;
  if (human.length < 200) {
    if (prevAsst) state += `\n\nAGENT'S PREVIOUS REPLY (end):\n${scrub(textOf(prevAsst.content).text).slice(-600)}`;
    if (prevHuman) state += `\n\nDEVELOPER'S PREVIOUS MESSAGE:\n${scrub(cleanHuman(prevHuman.text)).slice(0, 400)}`;
  }
  state += `\n\nSESSION: ${msgs.length} messages so far, ~${Math.round(estTokens / 1000)}k tokens of context.`;
  if (isRedacted) {
    // company project: only the redacted message and the shape (not the words) of the agent's last turn
    const shape = turnShape(msgs);
    state = `LATEST MESSAGE (data redacted, placeholders in brackets):\n${redactStrict(human, cfg.redactTerms, 600, getVocab(cfg))}`;
    if (shape) state += `\n\nAGENT'S LAST TURN (shape only): ${shape}`;
    state += `\n\nSESSION: ${msgs.length} messages so far, ~${Math.round(estTokens / 1000)}k tokens of context.`;
    appendFile(SENT_LOG, JSON.stringify({ ts: new Date().toISOString(), cwd: cwd.replace(/^\/Users\/[^/]+/, "~"), state }) + "\n").catch(() => {});
  }

  const jev = await askJev(cfg, key, state);
  if (!jev) {
    // Jev down: keep previous choice, or what the client asked for
    const model = th?.model ?? reqModel, effort = th?.effort ?? reqEffort;
    threads.set(thread, { model, effort, level: "pass", lastHuman: h, seen: now, steps: 0 });
    return finish({ ...base, kind: "fallback", model, effort, preview });
  }

  // pick the cheapest level L where P(task needs at most L) >= accept[L]
  let i = 0, cum = 0;
  for (; i < ORDER.length - 1; i++) {
    cum += jev.probs[ORDER[i]] ?? 0;
    // redacted messages carry less context: a cheaper level needs a bit more certainty, so errors go up, not down
    if (cum >= (cfg.accept[ORDER[i]] ?? 0.5) + (isRedacted ? 0.05 : 0)) break;
  }
  let level = ORDER[i];
  const notes: string[] = isRedacted ? ["redacted"] : [];
  // risky work (prod, deletes, credentials, money) gets at least the `hard` tier
  // Jev alone, or Jev half-sure plus a local risk word (redacted messages carry less context)
  const risky = (jev.risky ?? 0) >= cfg.riskyFloor || ((jev.risky ?? 0) >= 0.4 && riskyWords(cfg).test(human));
  if (risky && ORDER.indexOf(level) < ORDER.indexOf("hard")) {
    level = "hard"; notes.push("risky");
  }
  // "ok" / "go ahead" approve the work just proposed: never below the previous turn's level
  if (th && th.level !== "pass" && words(human) <= cfg.shortReplyWords && ORDER.indexOf(level) < ORDER.indexOf(th.level)) {
    level = th.level; notes.push("inherit");
  }
  const want = cfg.levels[level];
  // ratchet: the model only goes down while the context is small (a big prompt cache is costly to rebuild)
  const keep = th && rank(th.model) > rank(want.model) && estTokens >= cfg.freeSwitchTokens;
  const model = keep ? th!.model : want.model;
  if (th && rank(model) < rank(th.model)) notes.push("downgrade");
  threads.set(thread, { model, effort: want.effort, level, lastHuman: h, seen: now, steps: 0 });
  return finish({ ...base, kind: "human", model, effort: want.effort, level, wanted: want.model, probs: jev.probs, risky: jev.risky, jevMs: jev.ms, notes, preview });
}

export function applyDecision(body: any, d: Decision): any {
  const out = { ...body, model: d.model };
  if (d.effort && body.output_config) out.output_config = { ...body.output_config, effort: d.effort };
  else if (d.effort && !body.output_config && d.effort !== d.reqEffort) out.output_config = { effort: d.effort };
  return out;
}

// housekeeping
setInterval(() => {
  const cut = Date.now() - 6 * 3600_000;
  for (const [k, t] of threads) if (t.seen < cut) threads.delete(k);
}, 600_000).unref?.();
