// Allowlist for redacted (company) projects: a word may leave this machine only if we know it is
// an ordinary word. Everything else — customer, carrier, partner, person or product names, typos
// of them, codes — becomes [x]. Nobody has to maintain a list of names.
//
// Known words =
//   • lowercase entries of the system English dictionary (proper nouns there are capitalized, so skipped)
//   • words YOU typed in lowercase at least twice in prompts from NON-company projects (~/.claude/history.jsonl):
//     your own working vocabulary in whatever language you write, inflections included
//   • a small seed of Bosnian/Croatian/Serbian function words and generic dev / telecom terms (not names)
// Capitalized words in the middle of a sentence are treated as names even when they are dictionary words
// ("Orange", "Three"), unless they are generic tech terms.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SEED_BHS = `a i u o na za od do sa s iz po pri kod bez kroz preko oko prema ka nad pod pred između izmedju
je su sam si smo ste bi bih bismo biste bio bila bilo bili bude budu će ce ćemo cemo ću cu ćeš ces neće nece nije nisu nisam
da ne li ni ili pa te ali jer ako kad kada dok tek još jos već vec samo baš bas sve svi svaki nešto nesto ništa nista neko niko
šta sta što sto kako zašto zasto gde gdje koji koja koje koga kome čemu cemu ko kog čiji ciji ovo ono to taj ta ova ovaj onaj
ovde ovdje tamo sad sada onda opet isto takođe takodje može moze mogu možemo mozemo treba trebamo trebalo hoću hocu hoćeš hoces
hajde ajde aj daj evo eto ok okej jeste nije hvala molim pls ajmo kreni krenimo uradi uradimo proveri provjeri pogledaj vidi
napravi dodaj izmeni izmijeni promeni promijeni obriši obrisi popravi ispravi pokreni pusti deployaj deploy testiraj objasni
zašto znači znaci recimo npr itd slično slicno malo više vise manje dobro loše lose radi ne radi greška greska problem`;

const SEED_TECH = `api apis http https rest grpc json yaml xml csv sql nosql db database postgres postgresql mysql redis kafka
rabbitmq docker kubernetes k8s kubectl helm git github gitlab ci cd pipeline build deploy release rollback hotfix feature
branch merge commit pr pull push rebase tag env prod production staging dev local localhost server servis service backend
frontend ui ux css html js ts typescript javascript node bun npm pnpm yarn react next nextjs vue angular python go golang
rust java dotnet net csharp kotlin swift linux ubuntu macos bash zsh ssh vpn dns tcp udp ip sip rtp sbc pbx voip smpp
sms smsc mms otp msisdn imsi hlr mnp cdr cdrs asr acd pdd ner mos qos lcr route routes routing ruta rute rutu prefix prefiks
carrier carriers vendor vendors trunk trunks rate rates tarifa tarife cena cijena cene cijene minut minuti minuta kanal
kanali grafana loki mimir tempo alloy prometheus otel opentelemetry sentry coolify railway vercel aws gcp azure s3 ec2
lambda cron job jobs queue worker workers cache log logs logging metric metrics alert alerts dashboard panel query
endpoint endpoints webhook token auth oauth jwt login logout user users admin role roles permission permissions
test tests unit e2e lint migration migracija schema index tabela table column kolona row red mcp llm ai claude jev`;

const WORD = /[\p{L}][\p{L}\p{M}'’-]*/gu;
const isCap = (w: string) => /^\p{Lu}/u.test(w);

export interface Vocab {
  known: Set<string>;
  /** seed + your learned words (no English dictionary): what may start a sentence capitalized */
  core: Set<string>;
  /** generic terms that stay even when capitalized */
  tech: Set<string>;
  learned: number;
}

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);

export function buildVocab(excludeProjects: (p: string, sessionId?: string) => boolean): Vocab {
  const known = new Set<string>([...words(SEED_BHS), ...words(SEED_TECH)]);
  const core = new Set<string>(known);
  const tech = new Set<string>(words(SEED_TECH));
  try {
    for (const w of readFileSync("/usr/share/dict/words", "utf8").split("\n")) {
      if (w && w === w.toLowerCase()) known.add(w);
    }
  } catch {}
  // your own working vocabulary, from projects that are not company work
  const counts = new Map<string, number>();
  const hist = join(homedir(), ".claude/history.jsonl");
  if (existsSync(hist)) {
    for (const line of readFileSync(hist, "utf8").split("\n")) {
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r?.display || typeof r.project !== "string" || excludeProjects(r.project, r.sessionId)) continue;
      for (const sentence of String(r.display).split(/[.!?\n]+/)) {
        const ws = sentence.match(WORD) ?? [];
        ws.forEach((w, i) => {
          // only lowercase uses (names are typed capitalized); sentence-initial words count too
          if (i > 0 && isCap(w)) return;
          const k = w.toLowerCase();
          counts.set(k, (counts.get(k) ?? 0) + 1);
        });
      }
    }
  }
  let learned = 0;
  for (const [k, n] of counts) {
    if (n < 2) continue;
    if (!known.has(k)) learned++;
    known.add(k); core.add(k);
  }
  return { known, core, tech, learned };
}

/** Replace every word that is not known (or is a mid-sentence capitalized non-tech word) by [x]. */
export function allowlist(text: string, v: Vocab): string {
  return text
    .split(/(\[[a-z]+(?: \d+ lines)?\])/) // keep earlier placeholders intact
    .map((part) => {
      if (/^\[[a-z]+(?: \d+ lines)?\]$/.test(part)) return part;
      // letters+digits codes (A1, m3tel, node22): not words — drop unless generic tech
      part = part.replace(/\b(?=[\p{L}\d]*\d)(?=[\p{L}\d]*\p{L})[\p{L}\d]+\b/gu, (m) => (v.tech.has(m.toLowerCase()) ? m : "[x]"));
      return part.replace(WORD, (w, offset: number, whole: string) => {
        if (whole[offset - 1] === "[" && whole[offset + w.length] === "]") return w; // a placeholder made above
        const k = w.toLowerCase();
        const before = whole.slice(0, offset);
        const sentenceStart = /(^|[.!?:\n]\s*)$/.test(before);
        if (isCap(w) && !v.tech.has(k)) return sentenceStart && v.core.has(k) ? w : "[x]";
        return v.known.has(k) || v.tech.has(k) ? w : "[x]";
      });
    })
    .join("")
    .replace(/(\[x\]\s*){2,}/g, "[x] ");
}
