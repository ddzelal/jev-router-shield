import { describe, expect, test } from "bun:test";
import { redactStrict, turnShape } from "../src/redact";
import { allowlist, type Vocab } from "../src/vocab";

const vocab: Vocab = {
  known: new Set("check why the route for goes via and not price is in the logs please fix it today we deploy to prod".split(" ")),
  core: new Set("check why please fix".split(" ")),
  tech: new Set(["sms", "api", "prod", "deploy"]),
  learned: 0,
};

describe("redactStrict", () => {
  test("removes numbers, phones, amounts, hosts, ips, paths, urls, emails, secrets", () => {
    const out = redactStrict(
      "call +381 64 123 4567, price 0.0123 EUR, host sbc1.example.com 10.0.0.12, see /srv/app/conf.yml " +
        "https://internal.example.net/x mail ana@example.com token=abcd1234efgh5678",
    );
    for (const leak of ["381", "4567", "0.0123", "example", "10.0.0.12", "/srv", "ana@", "abcd1234"]) expect(out).not.toContain(leak);
    expect(out).toContain("[phone]");
    expect(out).toContain("[amount]");
  });
  test("pasted text and code never leave, only their size", () => {
    const out = redactStrict("look > [Pasted text #3 +40 lines] and ```secret code``` and `inline`");
    expect(out).toBe("look > [pasted 40 lines] and [code] and [code]");
  });
  test("listed terms become [name]", () => {
    expect(redactStrict("ask Acme Corp about it", ["Acme Corp"])).toBe("ask [name] about it");
  });
});

describe("allowlist", () => {
  test("names nobody listed become [x]", () => {
    const out = allowlist("check why the route for Globex goes via Initech and not Umbrella", vocab);
    expect(out).toBe("check why the route for [x] goes via [x] and not [x]");
  });
  test("capitalized dictionary words mid-sentence are treated as names", () => {
    expect(allowlist("check the route via Orange", { ...vocab, known: new Set([...vocab.known, "orange"]) })).toBe("check the route via [x]");
  });
  test("generic tech terms stay, codes with digits go", () => {
    expect(allowlist("fix the SMS api for node7x today", vocab)).toBe("fix the SMS api for [x] today");
  });
  test("placeholders survive", () => {
    expect(allowlist("check [phone] and [pasted 3 lines]", vocab)).toBe("check [phone] and [pasted 3 lines]");
  });
});

describe("turnShape", () => {
  test("describes the agent's last turn without its words", () => {
    const msgs = [
      { role: "user", content: "plan it" },
      { role: "assistant", content: [{ type: "tool_use", name: "Read" }, { type: "tool_use", name: "mcp__db__query" }] },
      { role: "user", content: [{ type: "tool_result", content: "secret rows" }] },
      { role: "assistant", content: [{ type: "text", text: "Plan:\n1. migrate Globex table\n2. deploy\nShall I start?" }] },
      { role: "user", content: "ok" },
    ];
    const s = turnShape(msgs);
    expect(s).toContain("a list/plan of 2 items");
    expect(s).toContain("ends with a question");
    expect(s).toContain("Read×1");
    expect(s).toContain("MCP×1");
    expect(s).not.toContain("Globex");
    expect(s).not.toContain("secret");
  });
});
