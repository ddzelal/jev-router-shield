import type { Config, Level } from "./config";

export interface JevResult {
  level: Level;
  probs: Record<string, number>;
  /** P(carrying out the message changes production, deletes data, touches credentials or money) */
  risky?: number;
  ms: number;
}

const CRITERIA: Record<Level, string> = {
  trivial:
    "No real work follows: thanks, small talk, a yes/no or one-line factual answer, re-running the exact same command. IMPORTANT: an approval or go-ahead ('ok', 'yes', 'go ahead', 'continue', 'do it', or the same in any language) starts the work the agent proposed in its previous reply, so judge the size of THAT work, not the length of the message.",
  routine:
    "Ordinary bounded task: small edit or rename, run a command and report, fix an obvious error, write a short text, look something up, follow an existing plan step.",
  substantial:
    "Real engineering work: implement a feature across a few files, debug a non-obvious problem, review code, research and compare options, write a detailed document.",
  hard:
    "Difficult work: design a system or architecture, hard production debugging, multi-step migration, security-sensitive or data-destroying operations, ambiguous requirements that need judgment.",
  extreme:
    "Exceptionally hard and long: novel algorithm or deep multi-system redesign where mistakes are very costly and maximum reasoning is clearly needed.",
};

export async function askJev(cfg: Config, key: string, state: string): Promise<JevResult | null> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.jevTimeoutMs);
  try {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.jevModel,
        state,
        questions: {
          level: {
            type: "choice",
            instructions:
              "The state is the latest message a developer sent to an AI coding agent (Claude Code), with a little prior context. How much model capability and reasoning effort does the agent need to handle THIS message well (including any work it approves)? Messages may be in any language.",
            criteria: CRITERIA,
          },
          risky: {
            type: "noul",
            instructions:
              "Would carrying out this message (including approving a plan the agent just proposed) deploy to or change production, delete or overwrite data, touch credentials or permissions, move money, or send something to outside people? Short approvals ('yes', 'go ahead', in any language) inherit the risk of what the agent proposed in its previous reply.",
          },
        },
      }),
    });
    if (!r.ok) {
      console.error("[jev-router-shield] jev http", r.status, (await r.text()).slice(0, 200));
      return null;
    }
    const j: any = await r.json();
    const a = j.answers?.level;
    if (!a?.probabilities) return null;
    const risky = typeof j.answers?.risky?.noul === "number" ? j.answers.risky.noul : undefined;
    return { level: a.choice, probs: a.probabilities, risky, ms: Math.round(performance.now() - t0) };
  } catch (e: any) {
    console.error("[jev-router-shield] jev error", e?.name ?? e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
