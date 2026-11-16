import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

export const NAME = "jev-router-shield";
export const DIR = join(homedir(), ".config", NAME);
export const LOG = join(DIR, "log.jsonl");

/** Tier = model + effort. Index order = capability order (ratchet only moves up in model rank). */
export type Level = "trivial" | "routine" | "substantial" | "hard" | "extreme";

export interface Config {
  port: number;
  upstream: string;
  jevModel: string;
  jevTimeoutMs: number;
  /** level -> model + effort sent to Anthropic */
  levels: Record<Level, { model: string; effort: string }>;
  /** model rank for the ratchet (higher = more capable) */
  modelRank: Record<string, number>;
  /** minimum probability needed to accept a cheaper level; otherwise go one level up */
  accept: Partial<Record<Level, number>>;
  /** above this estimated context (tokens) never route to a smaller model than requested */
  bigContextTokens: number;
  /** path fragments: prompts from these projects are never sent to Jev (local rules only) */
  trusted: string[];
  /** path fragments (set by `setup`): company/work projects — Jev sees only a strictly redacted message + the SHAPE of the agent's last turn */
  redacted: string[];
  /** names that must never leave in redacted projects (customers, carriers, partners, people) */
  redactTerms: string[];
  /** extra words allowed out of redacted projects: your language's common words, your domain jargon */
  extraWords: string[];
  /** extra risk words/stems (regex fragments) in your language, e.g. "sil\\w*"; a backup for Jev and the only signal in trusted projects */
  riskyWords: string[];
  /** idle minutes after which a thread may be re-decided from scratch */
  idleResetMin: number;
  /** below this context (tokens) the model may go DOWN mid-session: rebuilding a small cache is cheap */
  freeSwitchTokens: number;
  /** a reply of at most this many words ("ok", "go ahead") never gets a lower level than the turn before */
  shortReplyWords: number;
  /** Jev's P(risky) at or above this lifts the turn to at least `hard` */
  riskyFloor: number;
  /** a turn running at low effort is lifted to medium after this many tool-loop steps */
  lowEscalateSteps: number;
  /** $ per million tokens: input, output, cache read (cache write = 2× input, 1h TTL) */
  prices: Record<string, [number, number, number]>;
}

export const DEFAULTS: Config = {
  port: 4040,
  upstream: "https://api.anthropic.com",
  jevModel: "jev-latest",
  jevTimeoutMs: 1500,
  levels: {
    trivial: { model: "claude-sonnet-5-5", effort: "low" },
    routine: { model: "claude-sonnet-5-5", effort: "medium" },
    substantial: { model: "claude-opus-5-5", effort: "medium" },
    hard: { model: "claude-opus-5-5", effort: "high" },
    extreme: { model: "claude-opus-5-5", effort: "xhigh" },
  },
  modelRank: { "claude-haiku-5-5": 1, "claude-sonnet-5-5": 2, "claude-opus-5-5": 3, "claude-fable-5-1": 4, "claude-fable-5-2": 4 },
  // cumulative thresholds: cheaper levels need more certainty
  accept: { trivial: 0.8, routine: 0.75, substantial: 0.6, hard: 0.5 },
  bigContextTokens: 150_000,
  trusted: [],
  redacted: [],
  redactTerms: [],
  extraWords: [],
  riskyWords: [],
  idleResetMin: 60,
  freeSwitchTokens: 50_000,
  shortReplyWords: 6,
  riskyFloor: 0.7,
  lowEscalateSteps: 4,
  prices: { haiku: [0.1, 0.5, 0.01], sonnet: [2, 10, 0.1], opus: [4, 20, 0.2], fable: [8, 40, 0.2] },
};

export function loadConfig(): Config {
  const p = join(DIR, "config.json");
  if (!existsSync(p)) return DEFAULTS;
  try {
    const user = JSON.parse(readFileSync(p, "utf8"));
    return { ...DEFAULTS, ...user, levels: { ...DEFAULTS.levels, ...user.levels } };
  } catch (e) {
    console.error("[jev-router-shield] bad config.json, using defaults:", e);
    return DEFAULTS;
  }
}

export function loadKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const p = join(DIR, "env");
  if (!existsSync(p)) return;
  const m = readFileSync(p, "utf8").match(/^TYPESAFE_API_KEY=(.+)$/m);
  return m?.[1].trim();
}
