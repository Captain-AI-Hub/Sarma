# Sarma Code Map

This document is the repository atlas for Sarma's TypeScript/Bun implementation.

## Project Responsibility

Sarma is a terminal vulnerability-audit agent. It combines:

- Bun CLI packaging.
- OpenTUI/Solid full-screen UI.
- LangChain.js and LangGraph.js agent execution.
- MCP tool integration.
- Built-in web, fetch, network, terminal, RAG, skill, and SkillHub resources.
- Global/workspace TOML configuration.
- Workspace SQLite session persistence.

## System Entry Points

| Entry | Role |
| --- | --- |
| `src/index.ts` | CLI executable and command router. |
| `src/cli/app.ts` | One-shot mode, plain REPL, session list, workflow command. |
| `src/tui/index.ts` | Full-screen TUI startup and renderer lifecycle. |
| `src/session.ts` | Runtime session owner for both CLI and TUI. |
| `src/cli/ragCommand.ts` | `sarma rag` management command. |
| `package.json` | Bun package manifest, CLI bin, scripts, dependencies. |

## Directory Map

| Path | Responsibility | Key Files | Flow / Integration |
| --- | --- | --- | --- |
| Root | Package and project metadata. | `package.json`, `tsconfig.json`, `eslint.config.js`, `README.md`, `bunfig.toml` | Defines Bun CLI package, scripts, TypeScript aliases, lint/typecheck/test commands. |
| `src/index.ts` | Command-line entry adapter. | `index.ts` | Parses yargs commands, loads config, lazily imports TUI transform/runtime, dispatches to CLI/TUI/RAG/session commands. |
| `src/cli/` | Line-based CLI surfaces. | `app.ts`, `renderer.ts`, `ragCommand.ts` | Creates `Session`, sends user turns, renders `StreamEvent`s, manages plain slash commands, prints sessions/workflows/RAG status. |
| `src/tui/` | Full-screen UI layer. | `app.tsx`, `controller.ts`, `index.ts`, panels/components | `createController()` owns UI state/actions; Solid components render controller snapshots; session events update transcript, graph, tools, config/plugin/RAG panels. |
| `src/session.ts` | Runtime lifecycle service. | `session.ts` | Resolves run policy, connects MCP, compacts context, builds `AgentRunner`, persists messages/tool traces, tracks graph stage progress, owns cancellation and cleanup. |
| `src/runtime/` | Runtime planning, services, middleware, tool policy. | `resolver.ts`, `services.ts`, `middleware.ts`, `toolPolicy.ts` | Converts `CliConfig` to `RunPlan`, creates LangGraph checkpointer/store and terminal manager, builds filesystem/shell/terminal/retry/summarization middleware, filters explicit tools. |
| `src/engine/` | Agent execution core. | `agentFactory.ts`, `agentRunner.ts`, `mcpPool.ts`, `modelFactory.ts`, `streaming.ts`, `dto.ts`, `models.ts`, `toolAssembler.ts` | Normalizes config with DTOs, manages MCP clients, creates models, assembles tools, builds workflow graphs/agents, streams events to UI/CLI. |
| `src/workflows/` | Agent workflow definitions. | `ruflo.ts`, `auditGraph.ts`, `auditSlimGraph.ts`, `auditSubagents.ts`, `auditSlimSubagents.ts`, `index.ts` | Defines Ruflo delegation, full audit graph, slim audit graph, subagent specs/prompts, workflow metadata used by resolver/UI. |
| `src/resources/` | Built-in resource tools and installers. | `webTools.ts`, `networkTools.ts`, `terminalTools.ts`, `rag.ts`, `skills.ts`, `skillshub.ts` | Builds local tools, handles HTTP/fetch/network probing, persistent terminal sessions, RAG chunk/search, local skill discovery/install, SkillHub search/install. |
| `src/context/` | Context budget and compaction. | `compaction.ts`, `tokenizer.ts` | Estimates token budgets, plans compaction, creates structured memory messages, supports model-window-aware history reduction. |
| `src/config.ts` | Config schema, loading, merging, saving. | `config.ts` | Ensures `~/.sarma` and `./.sarma`, parses TOML, merges global/local MCP and RAG, persists models/agents/MCP/RAG. |
| `src/store.ts` | Workspace SQLite persistence. | `store.ts` | Creates/migrates `./.sarma/db.sqlite`, stores conversations, messages, tool executions, memory artifacts. |
| `src/paths.ts` | Path policy. | `paths.ts` | Centralizes global/workspace paths for config, skills, RAG, DB, history. |
| `src/debug.ts` | Debug logging. | `debug.ts` | Debug flag, debug log file, global process error handlers. |
| `tests/` | Verification suite. | `*.test.ts`, `fixtures/*` | Tests config, engine, runtime, session, RAG, TUI, streaming, CLI, mocked MCP servers. |

## Control Flow: One-Shot CLI

1. `src/index.ts` receives `sarma -c "..." --workflow audit-slim`.
2. `loadConfig()` loads global/workspace configuration.
3. `runOneshot()` validates workflow and model.
4. `Session` is created with `Store`.
5. `Session.runTurn()` emits `StreamEvent`s.
6. `StreamPrinter` renders token/tool/stage/run events.
7. `Session.close()` disconnects MCP and closes terminal sessions.
8. `Store.close()` closes SQLite.

## Control Flow: TUI

1. `src/index.ts` lazily registers OpenTUI Solid transform and imports `runTui`.
2. `src/tui/index.ts` creates renderer/controller/app.
3. `src/tui/app.tsx` renders transcript, status, sidebar, graph/config/plugin/RAG panels.
4. `controller.ts` accepts input and dispatches slash commands or user turns.
5. The controller streams from `Session.runTurn()` and projects events into TUI state.

## Control Flow: Runtime Planning

1. `RuntimePolicyResolver.agentFor()` resolves workflow or subagent config names.
2. `providerFor()` maps the agent model name to an enabled `ProviderConfig`.
3. `skillNamesFor()` expands skill wildcards and loads local/global skill config.
4. `workflowServers()` merges primary and subagent MCP allowlists into enabled server DTOs.
5. `resolve()` returns a `RunPlan` containing provider, servers, skill, prompt, subagent policy, and RAG DTO.

## Control Flow: Agent Execution

1. `AgentRunner.run()` builds `AgentRunConfig`.
2. `AgentFactory.build()` connects MCP and assembles tools.
3. `ToolAssembler` appends built-ins: `web_search`, `fetch_url`, `http_exchange`, `packet_exchange`, optional `rag_search`.
4. `filterToolsBySkill()` applies skill allow/deny lists to explicit MCP and built-in tools.
5. `AgentFactory` chooses Ruflo, full audit, or slim audit construction.
6. LangGraph stream chunks are translated to `StreamEvent`s.
7. Audit modes capture `stage_outputs.report` as final persisted assistant content.

## Data Flow: Persistence

| Data | Source | Sink |
| --- | --- | --- |
| Conversation metadata | `Session.newConversation()` | `Store.createConversation()` |
| User messages | `Session.runTurn()` | `messages` table |
| Assistant final response | `AgentRunner.finalContent` | `messages` table |
| Tool execution start/result/error | `StreamEvent` payloads | `tool_executions` table |
| Structured memory | `ContextCompactor` | `memory_artifacts` table and compacted message history |
| Config | TOML files | `CliConfig` and save helpers |

## Trust And Capability Map

| Capability | Owner | Boundary |
| --- | --- | --- |
| MCP tools | `McpClientPool`, configured MCP servers | Filtered by workflow MCP allowlists and skill tool policy. MCP server code/config is trusted. |
| Built-in tools | `ToolAssembler`, `resources/*` | Filtered by skill policy. Network tools require operator authorization. |
| Filesystem/shell middleware | `runtime/middleware.ts`, deepagents `LocalShellBackend` | Powerful local workspace capability. Intended for trusted high-automation use. |
| Persistent terminals | `resources/terminalTools.ts` | Workspace-bounded `cwd`, session-owned lifecycle, transcript logs under `./.sarma/<conversation>/terminals`. |
| Skills | `resources/skills.ts`, `resources/skillshub.ts` | Skill prompts and tool allow/deny lists are trusted local configuration. |
| RAG | `resources/rag.ts`, `config.ts` | Local native SQLite chunk DB or Chroma HTTP server. API embedding credentials come from config. |

## Design Patterns

- Adapter: `RuntimePolicyResolver` adapts TOML config classes into engine DTOs and run plans.
- Factory: `AgentFactory` constructs models, agents, and workflow graphs.
- Registry: `workflows/index.ts` stores workflow metadata; `toolPolicy.ts` stores built-in tool names.
- Presenter/controller: TUI controller projects runtime/session state to view models.
- Repository/DAO: `Store` encapsulates SQLite schema and persistence operations.
- Strategy: workflow mode selects Ruflo, full audit graph, or slim audit graph.
- Observer/stream: `StreamEvent`s decouple LangGraph streaming from UI and CLI rendering.

## Hotspots

| Hotspot | Reason | Next Step |
| --- | --- | --- |
| `src/tui/controller.ts` | Large mixed controller with command/config/plugin/RAG/session responsibilities. | Split by feature controller and presenter modules. |
| `src/resources/rag.ts` | Combines chunking, storage, embeddings, Chroma HTTP, search, and tool wrapping. | Split into RAG submodules. |
| `src/config.ts` | Large config schema/parser/saver/defaults file. | Keep exports stable and move internals into focused files. |
| `src/engine/agentFactory.ts` | Central workflow builder switch. | Keep as-is until workflow plugins are required; then add registry. |
| `src/runtime/toolPolicy.ts` | Static middleware tool count estimate. | Add runtime or test guard against dependency drift. |

