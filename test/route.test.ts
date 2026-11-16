import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../src/config";
import { applyDecision, decide } from "../src/route";

const cfg = { ...DEFAULTS, trusted: ["/secret-work/"] };
const req = (cwd: string, text: string, model = "claude-opus-5-5") => {
  const body = {
    model,
    output_config: { effort: "medium" },
    system: [{ type: "text", text: `Primary working directory: ${cwd}` }],
    messages: [{ role: "user", content: text }],
  };
  return [body, JSON.stringify(body)] as const;
};

describe("decide (no network)", () => {
  test("background models pass through", async () => {
    const [b, raw] = req("/home/u/app", "title this", "claude-haiku-5-5");
    expect((await decide(cfg, "k", b, "s1", raw)).kind).toBe("background");
  });
  test("Fable is never re-routed", async () => {
    const [b, raw] = req("/home/u/app", "do it", "claude-fable-5-2");
    const d = await decide(cfg, "k", b, "s2", raw);
    expect(d.kind).toBe("pinned");
    expect(d.model).toBe("claude-fable-5-2");
  });
  test("#fast tag picks Sonnet low without asking Jev", async () => {
    const [b, raw] = req("/home/u/app", "rename this var #fast");
    const d = await decide(cfg, undefined, b, "s3", raw);
    expect(d.model).toBe("claude-sonnet-5-5");
    expect(d.effort).toBe("low");
  });
  test("trusted folders never call Jev", async () => {
    const [b, raw] = req("/home/u/secret-work/api", "deploy this to prod please");
    const d = await decide(cfg, "k", b, "s4", raw);
    expect(d.kind).toBe("trusted");
  });
  test("applyDecision rewrites model and effort only", () => {
    const [b] = req("/x", "hi");
    const out = applyDecision(structuredClone(b), { model: "claude-sonnet-5-5", effort: "low" } as any);
    expect(out.model).toBe("claude-sonnet-5-5");
    expect(out.output_config.effort).toBe("low");
    expect(out.messages).toEqual(b.messages);
  });
});
