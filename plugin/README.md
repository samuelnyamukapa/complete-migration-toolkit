# cmtk plugin: the AI tester

Skills for GitHub Copilot (CLI and app) and Claude Code that do the grind of testing while people keep the judgement.

| Skill | What it does |
|---|---|
| `/cmtk:test` | Start here. Sets up cmtk in a project and walks from requirements to a signed report. Works for any project, not only migrations. |
| `/cmtk:plan` | Turns stories, a runbook, a requirements document or an OpenAPI file into a test plan and draft cases. Unclear points become questions. |
| `/cmtk:triage` | Goes through a comparison of an old and a new system, and proposes for each group of differences: noise, intended drift or a defect. |
| `/cmtk:explore` | Exploratory testing against a charter, read-only and within a budget. Findings become draft cases, with every request logged. |
| `/cmtk:defects` | Drafts defects from failures, with steps, expected, actual and evidence. Files them in your tracker only after you say yes. |

**Agents propose; people decide.** The skills write draft cases and proposals, and nothing counts until a person accepts it. That happens in a terminal, with `cmtk review` for drafts and proposals and `cmtk signoff` for a report. Both refuse to run from a script, and the plugin has no tool that approves or signs. Ask the agent for the exact commands: it gets them from `cmtk_commands_for_person`.

## Install

You need Node.js 22.5 or later, as `node` on your PATH. Nothing else: the MCP server and the `cmtk` command are bundled in the plugin's `server` folder.

**GitHub Copilot CLI**

```sh
copilot plugin marketplace add samuelnyamukapa/complete-migration-toolkit
copilot plugin install cmtk@complete-migration-toolkit
```

In the Copilot app, add the marketplace `samuelnyamukapa/complete-migration-toolkit` under Customize › Plugins, then install **cmtk**.

**Claude Code**

```text
/plugin marketplace add samuelnyamukapa/complete-migration-toolkit
/plugin install cmtk@complete-migration-toolkit
```

Or from a terminal:

```sh
claude plugin marketplace add samuelnyamukapa/complete-migration-toolkit
claude plugin install cmtk@complete-migration-toolkit --scope user
```

The commands are the same on Windows (PowerShell) and Linux.

## Check it works

1. Start a session in a project folder and type `/mcp`. The `cmtk` server should be connected.
2. Ask: *"Use /cmtk:test to test the app running at http://localhost:5002"*. The agent asks what to test and writes `cmtk.yaml`.
3. When it has drafted cases, run the review command it gives you, accept a few drafts, and ask it to run them.

To try it without a system of your own, use the bookshop example in the toolkit repository: `examples/bookshop` has a small server with planted bugs, its stories, and a runbook.

## Updating

- **Copilot:** run `copilot plugin marketplace update complete-migration-toolkit`, then `copilot plugin update cmtk@complete-migration-toolkit`.
- **Claude Code:** run `/plugin marketplace update complete-migration-toolkit`.
- **On Windows:** close every session first, because a running session can keep the plugin folder busy.

## What is inside

| Path | What |
|---|---|
| `skills/` | The five skills |
| `server/cmtk-mcp.mjs` | The cmtk MCP server, bundled: the tools the skills use |
| `server/cmtk.mjs` | The `cmtk` command, bundled: what a person runs for review and sign-off |
| `server/THIRD-PARTY-NOTICES.txt` | Licences of the bundled packages |
| `plugin.json`, `mcp.json` | For GitHub Copilot |
| `.claude-plugin/plugin.json`, `.mcp.json` | For Claude Code |

Licence: Apache-2.0.
