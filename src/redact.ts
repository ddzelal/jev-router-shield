import { allowlist, type Vocab } from "./vocab";

// Strict redaction for "redacted" projects (company work): what Jev may see is the SHAPE of a
// message, never its data. Everything that could identify a customer, number, route, host,
// price or secret is replaced by a typed placeholder. Fail closed: when in doubt, it goes.

/** "password" in many languages */
export const PASSWORD_WORDS =
  "password|passwd|pwd|passwort|kennwort|contrase[nñ]a|senha|mot de passe|parola|wachtwoord|lösenord|losenord|has[lł]o|lozinka|[sš]ifra|geslo|şifre|sifre|пароль|كلمة السر|密码|パスワード";

/** order matters: secrets and structured things first, generic numbers last */
const RULES: [RegExp, string][] = [
  [/```[\s\S]*?```/g, "[code]"],
  [/`[^`\n]{1,200}`/g, "[code]"],
  [/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[secret]"],
  [/\b(sk|pk|rk|ghp|gho|ghs|xox[bap]|AKIA|eyJ)[-_A-Za-z0-9.]{8,}/g, "[secret]"],
  [/(?<![\p{L}\d])(bearer|token|secret|api[_-]?key|key|user(?:name)?|login|password|passwd|pwd)\s*[:=]\s*\S+/giu, "$1 [secret]"],
  // a password word, one short linking word in any language ('is', 'ist', 'es', 'je'), then the value
  [new RegExp(`(?<![\\p{L}\\d])(${PASSWORD_WORDS})\\s+\\p{L}{1,6}\\s+\\S+`, "giu"), "$1 [secret]"],
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "[email]"],
  [/\b(?:https?|ftp|ssh|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|sip|wss?):\/\/\S+/gi, "[url]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?(?::\d+)?\b/g, "[ip]"],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  // any country-code domain (2 letters) plus common generic ones; file names like a.ts go too (fail closed)
  [/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|cloud|local|internal|lan|corp|tel|xyz|info|biz|online|tech|site|[a-z]{2})\b(?::\d+)?/gi, "[host]"],
  [/(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+[\w.@-]*/g, "[path]"],
  [/\b[A-Za-z]:\\[^\s]+/g, "[path]"],
  [/\b[0-9a-f]{16,}\b/gi, "[id]"],
  [/\b[A-Za-z0-9+/_-]{24,}={0,2}/g, "[secret]"],
  // phone numbers / MSISDN / E.164, with or without spaces and dashes
  [/(?:\+|\b00)\d[\d\s().-]{6,}\d/g, "[phone]"],
  [/\b\d[\d\s-]{7,}\d\b/g, "[phone]"],
  // money and prices
  // money: currency symbols, any ISO 4217 code (USD, EUR, TRY, …), common lowercase codes
  [/(?:[$€£¥₹₽₺₩]|\b[A-Z]{3}\b|\b(?:eur|usd|gbp|chf)\b)\s?\d[\d.,]*/g, "[amount]"],
  [/\b\d[\d.,]*\s?(?:[$€£¥₹₽₺₩]|[A-Z]{3}\b|(?:eur|usd|gbp|chf|cents?)\b)/g, "[amount]"],
  [/\b\d+[.,]\d+\b/g, "[num]"],
  // any number of 4+ digits (prefixes, IDs, counts, ports, dates)
  [/\b\d{4,}\b/g, "[num]"],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `terms`: names that must never leave (customers, carriers, partners, people). Case-insensitive, whole words. */
export function redactStrict(text: string, terms: string[] = [], maxChars = 600, vocab?: Vocab): string {
  let t = text
    // pasted blocks: never sent, only their size
    .replace(/\[pasted (\d+) chars\][\s\S]*/g, (_m, n) => `[pasted ${Math.max(1, Math.round(Number(n) / 60))} lines]`)
    .replace(/\[Pasted text #\d+(?: \+(\d+) lines)?[^\]]*\]/gi, (_m, n) => (n ? `[pasted ${n} lines]` : "[pasted]"))
    .replace(/\[Image #\d+\]/gi, "[image]");
  for (const term of terms.filter((x) => x.trim().length >= 2)) {
    t = t.replace(new RegExp(`(?<![\\p{L}\\d])${escape(term.trim())}(?![\\p{L}\\d])`, "giu"), "[name]");
  }
  for (const [re, rep] of RULES) t = t.replace(re, rep);
  // allowlist: only words known to be ordinary leave; names nobody listed become [x]
  if (vocab) t = allowlist(t, vocab);
  t = t.replace(/\s+/g, " ").trim();
  return t.length > maxChars ? t.slice(0, maxChars) + " …" : t;
}

/** Describe the agent's last turn without any of its words: size, plan steps, question, tools used. */
export function turnShape(msgs: any[]): string {
  // messages after the previous human message (the agent's last turn), excluding the current one
  const prior = msgs.slice(0, -1);
  let start = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    const isToolResult = Array.isArray(c) && c.some((b: any) => b?.type === "tool_result");
    if (!isToolResult) { start = i + 1; break; }
  }
  const tools: Record<string, number> = {};
  let lastText = "";
  for (const m of prior.slice(start)) {
    if (m?.role !== "assistant") continue;
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b?.type === "tool_use" && typeof b.name === "string") {
        const name = b.name.startsWith("mcp__") ? "MCP" : b.name.replace(/[^\w-]/g, "").slice(0, 24);
        tools[name] = (tools[name] ?? 0) + 1;
      }
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) lastText = b.text;
    }
  }
  if (!lastText && !Object.keys(tools).length) return "";
  const wordsN = lastText.trim() ? lastText.trim().split(/\s+/).length : 0;
  const steps = (lastText.match(/^\s*(?:\d+[.)]|[-*•])\s+/gm) ?? []).length;
  const asks = /\?\s*$/.test(lastText.trim());
  const parts = [`${wordsN} words`];
  if (steps) parts.push(`a list/plan of ${steps} items`);
  if (asks) parts.push("ends with a question to the developer (e.g. asking for approval)");
  const t = Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ");
  if (t) parts.push(`tools used: ${t}`);
  return parts.join("; ");
}
