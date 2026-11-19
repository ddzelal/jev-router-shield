# jev-router-shield

**Let [Jev](https://typesafe.ai) pick the Claude model and effort for every message in Claude Code, including at work, without your company's data leaving your machine.**

A small local proxy between Claude Code and the Anthropic API. On every message you type, it asks Jev (TypeSafe's ~200 ms "System One" classifier) how much capability the message needs, then sets the model and effort. Tool-loop steps reuse that choice, so a turn never switches models halfway.

| Jev level | Model | Effort |
|---|---|---|
| trivial | Sonnet 5.5 | low |
| routine | Sonnet 5.5 | medium |
| substantial | Opus 5.5 | medium |
| hard | Opus 5.5 | high |
| extreme | Opus 5.5 | xhigh |

Other Jev routers exist. This one adds three things:

1. **Work-safe mode ("shield").** In folders you mark as work, Jev never sees your text. It sees a redacted skeleton: numbers, phones, prices, hosts, IPs, URLs, paths, IDs, emails and secrets become typed placeholders, and pasted text and code never leave. On top of that, an **allowlist** applies: a word goes out only if it is known to be ordinary. Customer, partner, product and people names become `[x]` without anyone keeping a list of them. Every state sent from a work folder is written to an audit log (`jev-router-shield sent`).
2. **Rules tuned on real sessions:**
   - Short approvals like "ok, go" inherit the size of the work they approve.
   - Risky turns (prod, deletes, migrations, credentials) go to at least Opus high.
   - Long low-effort tool loops are lifted to medium.
   - The model only goes down while the context is small, so the prompt cache stays warm.
3. **A live card above the prompt** showing the model, effort, context, why Jev chose this level, and what the session costs at API list prices.

```
╭──────────────────────────────────────────────────────────────────────────────────────╮
│  JEV   ● Opus 5.5  effort ▰▰▱▱▱ med  ctx ▰▰▰▰▰▱▱▱ 140k             ⟳ working · step 4  ▴ │
│ Jev routine ███░░ 77% → wants sonnet  ■ kept opus (ratchet)  182ms  │ session opus 82% sonnet 18% │
│ used skill pdf  agents Explore×2  MCP github×3  Bash×7 Read×4 Edit×2                         │
│ ≈ $1.84 this session · $12.40 today (API list price) · saved $3.10                        │
╰──────────────────────────────────────────────────────────────────────────────────────╯
```

## Install

Requirements: macOS or Linux (systemd), [Bun](https://bun.sh) ≥ 1.1, Claude Code, and a TypeSafe API key.

```sh
curl -fsSL https://raw.githubusercontent.com/ddzelal/jev-router-shield/main/install.sh | sh
```

The script clones this repo into `~/.jev-router-shield` and runs `setup`. Setup does the following:

- asks for your TypeSafe key and stores it in `~/.config/jev-router-shield/env` (mode 600);
- asks which folders are work folders;
- starts the proxy on `127.0.0.1:4040` (launchd on macOS, `systemd --user` on Linux);
- points Claude Code at the proxy (`ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, with a backup);
- installs the card.

Then open a new Claude Code session.

To set it up without prompts:

```sh
git clone https://github.com/ddzelal/jev-router-shield ~/.jev-router-shield
bun ~/.jev-router-shield/src/cli.ts setup --key "$TYPESAFE_API_KEY" --work "/work/,acme-" --yes
```

To install only the card (the proxy must be installed separately): `/plugin marketplace add ddzelal/jev-router-shield`, then `/plugin install jev-router-shield@jev-router-shield`.

`jev-router-shield uninstall` removes the service and the settings entry. Your config and logs stay.

## Folder modes

| Mode | Set with | What Jev sees |
|---|---|---|
| normal (default) | none | your latest message after scrubbing secrets, IPs and long tokens (max 2.5k chars), plus a short prior context for one-word replies |
| **work** | `--work "/work/,acme-"` → `redacted` in config | only the redacted, allowlisted message plus the *shape* of the agent's last turn (word count, number of plan items, whether it asked a question, tool names). Never tool output, files, code or pasted text. |
| never | `--never "/secret/"` → `trusted` in config | nothing. Routing uses local rules only (risk words, approvals). |

Folders match on path fragments, so `/work/` covers everything under any `.../work/` directory.

### How the allowlist knows which words are ordinary

A word in a work folder leaves your machine only if it is one of these:

- a lowercase word from the system dictionary (`/usr/share/dict/words`; proper nouns there are capitalized and skipped);
- a word **you** typed in lowercase at least twice in Claude Code prompts from non-work folders (`~/.claude/history.jsonl`). This is your own working vocabulary in your language, read locally and never uploaded;
- a generic software term (SQL, deploy, endpoint…);
- a word in `extraWords` in your config: common words of your language or your domain jargon, if your history is still short.

A capitalized word in the middle of a sentence counts as a name, even when it is in the dictionary ("Orange", "Three"). So does a letters-plus-digits code (`A1`, `node7x`).

Example:

> `Check why the route for +381 64 123 4567 goes via Globex and not Initech, price 0.0123 EUR`

becomes

> `Check why the route for [phone] goes via [x] and not [x], price [amount]`

On the author's own prompts (held out from vocabulary learning), Jev's level matched the unredacted level 68–70% of the time and was within one level 98–100% of the time, with about 12–15% of words masked. In work folders a cheaper level needs a little more certainty (+0.05), so mistakes lean toward the stronger model.

`redactTerms` in the config adds names to always replace with `[name]`, as an extra layer.

Any language works: Jev reads any language, and the vocabulary comes from your own prompts. Two optional config lists help:

```json
{
  "extraWords": ["merhaba", "lütfen", "kontrol", "et"],
  "riskyWords": ["sil\\w*", "canlıya"]
}
```

`riskyWords` are regex fragments that count as risk words on top of the English ones (prod, deploy, delete, migrate…).

**Limits:** redaction is pattern-based. It is designed to fail closed, but it is not a formal guarantee. Read `jev-router-shield sent` for a while after setting it up and decide for yourself.

## Rules

- **Approvals inherit.** A reply of ≤ 6 words never gets a lower level than the turn before. Jev is also told that an approval is as big as the work it approves.
- **Risk floor.** If Jev's P(risky) is ≥ 0.7, or ≥ 0.4 and the message contains a risk word, the turn goes to at least `hard` (Opus high).
- **Low-effort escalation.** A `low` turn that runs past 4 tool steps continues on `medium`. Changing effort keeps the prompt cache.
- **Cache-aware ratchet.** Below 50k tokens of context the model may go down. Above that it only goes up, because a model switch rebuilds the cache.
- **Big-context guard.** Above 150k tokens the router never picks a smaller model than Claude Code asked for.
- An hour of idle time resets a thread.
- Fable and background Haiku calls are never touched.
- If Anthropic rejects a rewritten request, the original is re-sent untouched. If Jev is down, the previous choice is used.

Message tags override routing for one turn: `#fast` `#sonnet` `#opus` `#max` `#fable` `#nojev`.

## The card

- **Line 1 (live):** model and effort of the request in flight (tool steps included), the context meter (yellow from 100k, red from 150k: time for a fresh session), and working/idle.
- **Line 2:** Jev's level and confidence for your last message, what the router did, rule chips (`redacted`, `risky`, `inherit`, `escalated`), and the session's model mix.
- **Line 3, "used":** what Claude used since your last message: skills, subagents, MCP servers (by server) and the other tools, with counts, subagents' calls included. `/jev-activity` lists the same for the turn and the whole session.
- **Line 4:** API-list-price equivalent for the session and for today, and how much routing saved.
- **Big context:** above 150k tokens every request re-reads the whole context, and the router will not move to a smaller model (the cache would be lost). The card then shows `↻ big context: /jev-handoff`. That command has Claude write a handoff note to `~/.claude/handoffs/`. Open a new session in the same folder and type `/jev-resume` to continue from it with a small context.
- The `◆ Jev` footer button (hotkey `j`) or `/jev` pauses routing for this session only. `▴`/`▾` switches to a one-line view.

## Orca

In [Orca](https://github.com/stablyai/orca), agents opened as a **chat** do not draw Claude Code's card. Install the Orca panel in [`orca-plugin/`](orca-plugin/) to see the same card for every Claude agent of a workspace, chat or terminal.

## Commands

```
jev-router-shield setup [--key K] [--work "a,b"] [--never "c"] [--port N] [--yes]
jev-router-shield status            # service, Claude Code link, key, folder modes
jev-router-shield report [days]     # models, levels, rules; skills, subagents, MCP servers, tools; cost by project
jev-router-shield sent [n]          # exactly what left the machine from work folders
jev-router-shield logs [n] | config
jev-router-shield off | on          # bypass without stopping the service
jev-router-shield restart | uninstall
```

All files live in `~/.config/jev-router-shield/`:

| File | Contents |
|---|---|
| `config.json` | overrides of the `src/config.ts` defaults |
| `env` | the key |
| `log.jsonl` | decisions only, no message text |
| `sent.jsonl` | the audit of what work folders sent |

## Privacy, plainly

- The proxy runs on localhost and sees all Claude Code ↔ Anthropic traffic, as any gateway does. It forwards that traffic unchanged except for `model` and `effort`.
- The only third party is TypeSafe (Jev). What is sent to it in each folder mode is listed above.
- Nothing is uploaded anywhere else. No telemetry.

## Develop

```sh
bun test                              # redaction, allowlist, routing rules (no network)
bun scripts/eval-history.ts 40        # classify 40 of your past non-work prompts with Jev
```

MIT licensed. Not affiliated with Anthropic or TypeSafe.
