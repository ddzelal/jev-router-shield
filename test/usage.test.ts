import { expect, test } from "bun:test";
import { usedIn } from "../src/usage";

test("counts the previous step's tool calls once, by kind", () => {
  const body = { messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [
      { type: "tool_use", name: "Skill", input: { skill: "pdf" } },
      { type: "tool_use", name: "Agent", input: { subagent_type: "Explore", prompt: "secret" } },
      { type: "tool_use", name: "mcp__github__create_issue", input: {} },
      { type: "tool_use", name: "Bash", input: { command: "rm -rf x" } },
    ] },
    { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  ] };
  expect(usedIn(body)).toEqual(["skill:pdf", "agent:Explore", "mcp:github", "Bash"]);
});

test("slash commands you typed; nothing on a plain message", () => {
  expect(usedIn({ messages: [{ role: "user", content: "<command-name>/review</command-name> x" }] })).toEqual(["cmd:review"]);
  expect(usedIn({ messages: [{ role: "user", content: "hello" }] })).toEqual([]);
});
