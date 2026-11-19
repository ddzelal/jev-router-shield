#!/usr/bin/env bun
// jev-router-shield CLI: setup | install | uninstall | on | off | status | report | logs | sent | config
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync, symlinkSync, unlinkSync } from "fs";
import { homedir, platform } from "os";
import { join, resolve } from "path";
import { $ } from "bun";
import { DIR, LOG, NAME, loadConfig } from "./config";

const HOME = homedir();
const SETTINGS = join(HOME, ".claude/settings.json");
const CONFIG = join(DIR, "config.json");
const KEYFILE = join(DIR, "env");
const ROOT = resolve(import.meta.dir, "..");
const IS_MAC = platform() === "darwin";
const LABEL = `dev.${NAME}`;
const PLIST = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const UNIT = join(HOME, ".config/systemd/user", `${NAME}.service`);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
};
const YES = args.includes("--yes") || args.includes("-y");

let cfg = loadConfig();
const url = () => `http://127.0.0.1:${cfg.port}`;

function readSettings(): any {
  return existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf8")) : {};
}
function writeSettings(s: any) {
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.bak-${NAME}`);
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
}
async function healthy() {
  try {
    const r = await fetch(url() + "/__jev/health", { signal: AbortSignal.timeout(1000) });
    return r.ok && (await r.json()).name === NAME;
  } catch {
    return false;
  }
}

function on() {
  const s = readSettings();
  const cur = s.env?.ANTHROPIC_BASE_URL;
  if (cur && cur !== url() && !YES) {
    console.error(`~/.claude/settings.json already points to another gateway (${cur}); not touching it. Re-run with --yes to replace.`);
    process.exit(1);
  }
  s.env = { ...(s.env ?? {}), ANTHROPIC_BASE_URL: url() };
  writeSettings(s);
  console.log(`✓ Claude Code → ${url()} (new sessions)`);
}
function off() {
  const s = readSettings();
  if (s.env?.ANTHROPIC_BASE_URL === url()) {
    delete s.env.ANTHROPIC_BASE_URL;
    if (!Object.keys(s.env).length) delete s.env;
    writeSettings(s);
  }
  console.log("✓ Claude Code → direct to Anthropic (new sessions)");
}

async function startService() {
  mkdirSync(DIR, { recursive: true });
  const bun = process.execPath;
  const server = join(ROOT, "src/server.ts");
  const logf = join(DIR, "server.log");
  if (IS_MAC) {
    mkdirSync(join(HOME, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${bun}</string><string>${server}</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logf}</string>
  <key>StandardErrorPath</key><string>${logf}</string>
</dict></plist>
`);
    const uid = process.getuid!();
    // already loaded → restart in place (bootout is async, an immediate bootstrap fails with EIO)
    const loaded = (await $`launchctl print gui/${uid}/${LABEL}`.quiet().nothrow()).exitCode === 0;
    if (loaded) await $`launchctl bootout gui/${uid}/${LABEL}`.quiet().nothrow();
    for (let i = 0; i < 10; i++) {
      if ((await $`launchctl bootstrap gui/${uid} ${PLIST}`.quiet().nothrow()).exitCode === 0) break;
      await Bun.sleep(300);
    }
  } else {
    mkdirSync(join(HOME, ".config/systemd/user"), { recursive: true });
    writeFileSync(UNIT, `[Unit]
Description=${NAME}: Jev model/effort router for Claude Code

[Service]
ExecStart=${bun} ${server}
WorkingDirectory=${ROOT}
Restart=always
StandardOutput=append:${logf}
StandardError=append:${logf}

[Install]
WantedBy=default.target
`);
    await $`systemctl --user daemon-reload`.quiet();
    await $`systemctl --user enable --now ${NAME}.service`.quiet();
    await $`systemctl --user restart ${NAME}.service`.quiet();
  }
  for (let i = 0; i < 20 && !(await healthy()); i++) await Bun.sleep(250);
  if (!(await healthy())) {
    console.error(`router did not start; see ${logf}`);
    process.exit(1);
  }
  console.log(`✓ router running on ${url()} (${IS_MAC ? `launchd ${LABEL}` : `systemd --user ${NAME}`})`);
}
async function stopService() {
  if (IS_MAC) {
    await $`launchctl bootout gui/${process.getuid!()}/${LABEL}`.quiet().nothrow();
    await $`rm -f ${PLIST}`.quiet();
  } else {
    await $`systemctl --user disable --now ${NAME}.service`.quiet().nothrow();
    await $`rm -f ${UNIT}`.quiet();
    await $`systemctl --user daemon-reload`.quiet().nothrow();
  }
}

async function installMod() {
  const claude = Bun.which("claude");
  if (!claude) return console.log("• Claude Code CLI not found: install the card later with\n    claude plugin marketplace add " + ROOT + `\n    claude plugin install ${NAME}@${NAME}`);
  await $`${claude} plugin marketplace add ${ROOT}`.quiet().nothrow();
  const r = await $`${claude} plugin install ${NAME}@${NAME}`.quiet().nothrow();
  console.log(r.exitCode === 0 ? "✓ card installed in Claude Code (run /reload-plugins in open sessions)" : "• card not installed: " + r.stderr.toString().trim());
}

function saveConfig(patch: Record<string, unknown>) {
  mkdirSync(DIR, { recursive: true });
  const cur = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  writeFileSync(CONFIG, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
  cfg = loadConfig();
}

function linkBin() {
  const bin = join(HOME, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const target = join(ROOT, "src/cli.ts");
  chmodSync(target, 0o755);
  try { unlinkSync(join(bin, NAME)); } catch {}
  symlinkSync(target, join(bin, NAME));
  const onPath = (process.env.PATH ?? "").split(":").includes(bin);
  console.log(`✓ ${NAME} → ${join(bin, NAME)}${onPath ? "" : `  (add ${bin} to your PATH)`}`);
}

/** setup: key, work folders, service, Claude Code settings, card. Safe to re-run. */
async function setup() {
  console.log(`${NAME} setup\n`);
  mkdirSync(DIR, { recursive: true });

  // 1. TypeSafe key
  let key = flag("key") ?? process.env.TYPESAFE_API_KEY;
  if (!key && existsSync(KEYFILE)) key = readFileSync(KEYFILE, "utf8").match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!key && !YES) key = prompt("TypeSafe API key (https://typesafe.ai) — empty = run as pass-through:")?.trim() || undefined;
  if (key) {
    writeFileSync(KEYFILE, `TYPESAFE_API_KEY=${key}\n`);
    chmodSync(KEYFILE, 0o600);
    console.log(`✓ key saved to ${KEYFILE} (mode 600)`);
  } else console.log("• no key: requests pass through unchanged until you add one (re-run setup)");

  // 2. work folders → redacted mode
  let work = flag("work");
  if (work === undefined && !YES) {
    console.log(`\nWork / company folders: prompts from these go to Jev only after strict redaction
(numbers, names, hosts, paths, secrets removed; only known ordinary words leave). Path fragments, comma separated,
e.g.  /work/, acme-api   (current: ${cfg.redacted.join(", ") || "none"})`);
    work = prompt("Work folders (empty = keep current):") ?? "";
  }
  if (work) saveConfig({ redacted: work.split(",").map((s) => s.trim()).filter(Boolean) });
  let never = flag("never");
  if (never) saveConfig({ trusted: never.split(",").map((s) => s.trim()).filter(Boolean) });
  const port = flag("port");
  if (port) saveConfig({ port: Number(port) });
  console.log(`✓ config: ${CONFIG}`);

  // 3. CLI on PATH, service, Claude Code
  linkBin();
  await startService();
  on();
  await installMod();
  console.log(`\nDone. Open a new Claude Code session. \`${NAME} status\` checks it, \`${NAME} uninstall\` undoes it.`);
}

async function uninstall() {
  off();
  await stopService();
  const claude = Bun.which("claude");
  if (claude) await $`${claude} plugin uninstall ${NAME}@${NAME}`.quiet().nothrow();
  console.log(`✓ router stopped and removed (config and logs kept in ${DIR})`);
}

async function status() {
  const s = readSettings();
  const up = await healthy();
  console.log("router:", up ? `running at ${url()}` : "NOT running");
  console.log("claude:", s.env?.ANTHROPIC_BASE_URL === url() ? `routed through ${NAME}` : "direct");
  console.log("jev key:", existsSync(KEYFILE) || process.env.TYPESAFE_API_KEY ? "set" : "missing (pass-through)");
  console.log("work folders (redacted):", cfg.redacted.join(", ") || "none");
  if (cfg.trusted.length) console.log("never sent to Jev:", cfg.trusted.join(", "));
  if (s.env?.ANTHROPIC_BASE_URL === url() && !up) console.log(`⚠️  Claude Code points to the router but it is down → \`${NAME} off\` or \`${NAME} setup\``);
}

function report(days = 7) {
  if (!existsSync(LOG)) return console.log("no log yet");
  const since = Date.now() - days * 86400_000;
  const rows = readFileSync(LOG, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && Date.parse(r.ts) >= since);
  const by = (f: (r: any) => string) => rows.reduce((m: Record<string, { n: number; ctx: number }>, r) => {
    const k = f(r); m[k] ??= { n: 0, ctx: 0 }; m[k].n++; m[k].ctx += r.ctx || 0; return m; }, {});
  const show = (title: string, m: Record<string, { n: number; ctx: number }>) => {
    console.log(`\n${title}`);
    for (const [k, v] of Object.entries(m).sort((a, b) => b[1].ctx - a[1].ctx))
      console.log(`  ${k.padEnd(36)} req=${String(v.n).padStart(5)}  ctx=${(v.ctx / 1e6).toFixed(1).padStart(7)}M`);
  };
  console.log(`${NAME} report — last ${days} days, ${rows.length} requests`);
  show("Sent model/effort", by((r) => r.sent));
  show("Decision kind", by((r) => r.kind));
  show("Level (human turns)", by((r) => r.kind === "human" ? r.level : "(not decided)"));
  show("Rules applied", by((r) => (r.notes?.length ? r.notes.join("+") : "(none)")));
  const moved = rows.filter((r) => r.req?.startsWith("claude-opus") && r.sent?.startsWith("claude-sonnet"));
  const lowered = rows.filter((r) => r.req?.split("/")[0] === r.sent?.split("/")[0] && r.req !== r.sent);
  const tot = rows.reduce((a, r) => a + (r.ctx || 0), 0) || 1;
  console.log(`\nOpus → Sonnet: ${moved.length} req, ${(100 * moved.reduce((a, r) => a + r.ctx, 0) / tot).toFixed(0)}% of context tokens`);
  console.log(`Same model, effort changed: ${lowered.length} req`);
  console.log(`Retried with original (rejected rewrite): ${rows.filter((r) => r.retried).length}`);
  // what Claude used (logged since v0.2): skills, subagents, MCP servers, slash commands, tools
  const used: Record<string, Record<string, number>> = { skill: {}, agent: {}, mcp: {}, cmd: {}, tool: {} };
  for (const r of rows) for (const u of r.used ?? []) {
    const m = /^(skill|agent|mcp|cmd):(.+)$/.exec(u);
    const [k, n] = m ? [m[1], m[2]] : ["tool", u];
    used[k][n] = (used[k][n] ?? 0) + 1;
  }
  const list = (title: string, m: Record<string, number>, n = 12) => {
    const e = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);
    if (e.length) console.log(`\n${title}\n  ` + e.map(([k, v]) => `${k} ${v}`).join("  ·  "));
  };
  if (rows.some((r) => r.used)) {
    list("Skills", used.skill); list("Subagents", used.agent); list("MCP servers (calls)", used.mcp);
    list("Slash commands you typed", used.cmd); list("Tools", used.tool, 15);
  }
  // API-list-price equivalent by project (logged since v0.2)
  const cost: Record<string, number> = {};
  for (const r of rows) if (r.usd) { const k = String(r.cwd ?? "?").split("/").slice(0, 3).join("/"); cost[k] = (cost[k] ?? 0) + r.usd; }
  if (Object.keys(cost).length) {
    console.log("\nAPI-price equivalent by project");
    for (const [k, v] of Object.entries(cost).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k.padEnd(36)} $${v.toFixed(2)}`);
  }
  const big = rows.filter((r) => r.ctx > 150_000);
  console.log(`Requests with >150k context: ${big.length} (${(100 * big.reduce((a, r) => a + r.ctx, 0) / tot).toFixed(0)}% of tokens) ← start fresh sessions more often`);
}

function sent(n = 10) {
  // audit: exactly what left this machine for Jev from work (redacted) folders
  const f = join(DIR, "sent.jsonl");
  if (!existsSync(f)) return console.log("nothing sent from work folders yet");
  for (const l of readFileSync(f, "utf8").trim().split("\n").slice(-n)) {
    const r = JSON.parse(l);
    console.log(`── ${r.ts}  ${r.cwd}\n${r.state}\n`);
  }
}

const [cmd, arg] = args;
switch (cmd) {
  case "setup": await setup(); break;
  case "install": await startService(); on(); break;
  case "restart": await startService(); break;
  case "uninstall": await uninstall(); break;
  case "on": on(); break;
  case "off": off(); break;
  case "status": await status(); break;
  case "report": report(Number(arg) || 7); break;
  case "logs": await $`tail -n ${Number(arg) || 30} ${LOG}`.nothrow(); break;
  case "sent": sent(Number(arg) || 10); break;
  case "config": console.log(CONFIG + "\n" + JSON.stringify(cfg, null, 2)); break;
  default:
    console.log(`${NAME} setup [--key K] [--work "a,b"] [--never "c"] [--port N] [--yes]
${NAME} status | report [days] | logs [n] | sent [n] | config
${NAME} on | off | restart | uninstall

In a message: #fast #sonnet #opus #max #fable #nojev`);
}
