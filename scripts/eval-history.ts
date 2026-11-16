// Classify a random sample of your past Claude Code prompts with Jev (no Claude calls): bun scripts/eval-history.ts [n]
import { readFileSync } from "fs";
import { homedir } from "os";
import { loadConfig, loadKey } from "../src/config";
import { askJev } from "../src/jev";
import { cleanHuman, isCompany, scrub } from "../src/route";
const cfg = loadConfig(), key = loadKey()!;
const ORDER = ["trivial", "routine", "substantial", "hard", "extreme"] as const;
const n = Number(process.argv[2] ?? 40);
const lines = readFileSync(homedir() + "/.claude/history.jsonl", "utf8").trim().split("\n");
// work folders are skipped: their prompts never go to Jev unredacted
const prompts = lines.map((l) => { try { const r = JSON.parse(l); return isCompany(cfg, r.project ?? "") ? "" : (r.display as string); } catch { return ""; } })
  .map((p) => cleanHuman(p ?? "")).filter((p) => p && !p.startsWith("/") && p.length > 1);
const sample = [...new Set(prompts)].sort(() => Math.random() - 0.5).slice(0, n);
const counts: Record<string, number> = {};
for (const p of sample) {
  const r = await askJev({ ...cfg, jevTimeoutMs: 5000 }, key, `LATEST MESSAGE:\n${scrub(p).slice(0, 2500)}`);
  if (!r) { console.log("ERR"); continue; }
  let i = 0, cum = 0;
  for (; i < ORDER.length - 1; i++) { cum += r.probs[ORDER[i]] ?? 0; if (cum >= (cfg.accept[ORDER[i]] ?? 0.5)) break; }
  const lvl = ORDER[i]; counts[lvl] = (counts[lvl] ?? 0) + 1;
  console.log(`${lvl.padEnd(11)} ${cfg.levels[lvl].model.replace("claude-", "").padEnd(10)} ${cfg.levels[lvl].effort.padEnd(6)} | ${scrub(p).replace(/\s+/g, " ").slice(0, 110)}`);
}
console.log("\n", counts);
