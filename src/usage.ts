// What Claude used, read from the request itself: each tool-loop request carries the tool calls of the step
// before it (the last assistant message, answered by tool_result blocks), so every call is counted once.
// Names only, never arguments, except the skill / subagent type / MCP server name.

/** "skill:pdf", "agent:Explore", "mcp:github", "cmd:review", or the plain tool name */
export function usedIn(body: any): string[] {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const lastMsg = msgs.at(-1);
  const out: string[] = [];
  const blocks = (m: any) => (Array.isArray(m?.content) ? m.content : []);
  const isToolResult = blocks(lastMsg).some((b: any) => b?.type === "tool_result");
  if (isToolResult) {
    const prev = [...msgs].reverse().find((m) => m?.role === "assistant");
    for (const b of blocks(prev)) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const name: string = b.name;
      if (name === "Skill") out.push(`skill:${clean(b.input?.skill)}`);
      else if (name === "Agent" || name === "Task") out.push(`agent:${clean(b.input?.subagent_type ?? "general-purpose")}`);
      else if (name.startsWith("mcp__")) out.push(`mcp:${clean(name.split("__")[1])}`);
      else out.push(clean(name));
    }
  } else if (lastMsg?.role === "user") {
    // a slash command / skill you typed shows up as <command-name>/x</command-name>
    const text = typeof lastMsg.content === "string" ? lastMsg.content : blocks(lastMsg).map((b: any) => b?.text ?? "").join("\n");
    for (const m of text.matchAll(/<command-name>\/?([\w:.-]{1,64})<\/command-name>/g)) out.push(`cmd:${m[1]}`);
  }
  return out;
}

const clean = (s: unknown) => String(s ?? "?").replace(/[^\w:.@-]/g, "").slice(0, 64) || "?";
