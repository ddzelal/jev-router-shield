# Jev panel for Orca

A sidebar panel for [Orca](https://github.com/stablyai/orca) that shows the jev-router-shield card for every Claude Code agent in the focused workspace, **including agents opened as a chat**, where Claude Code's own card above the prompt is not drawn.

Each card: model, effort, context meter, Jev's level and confidence, what the router did, rule chips, tools/skills/agents/MCP used this turn, the session's model mix and its API-list-price cost.

The panel's worker reads only the local proxy (`http://127.0.0.1:4040/__jev/last`). It sends nothing anywhere.

```sh
orca plugin install ~/.jev-router-shield/orca-plugin --json   # prints the access it asks for; re-run with --approve <fingerprint>
orca plugin open local.jev-router-shield --panel jev-router-shield
```

Access: `agent:read` and `workspace:read` (to match Orca agents to Claude Code session ids), plus a small Node worker.

Develop: `orca plugin test . --json`, `orca plugin validate . --json`.
