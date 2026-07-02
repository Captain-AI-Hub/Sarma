# Sarma Architecture Audit

Audit date: 2026-07-01

## Summary

Sarma is a Bun/TypeScript terminal application for vulnerability-audit agent workflows. The architecture is broadly layered:

1. CLI/TUI entry points collect user intent.
2. `Session` owns conversation lifecycle, persistence coordination, MCP connection reuse, runtime restart, cancellation, graph progress, and context compaction.
3. `RuntimePolicyResolver` converts TOML configuration into a per-turn `RunPlan`.
4. `AgentRunner` executes one turn and emits normalized stream events.
5. `AgentFactory` builds LangGraph agents or audit graphs from DTOs, tools, middleware, and workflow metadata.
6. `resources/*` provides local tools: RAG, web/fetch, network probing, terminal sessions, skills, and SkillHub.
7. `Store` and `config` provide durable workspace/global state.

The main architecture is coherent and test-backed. The remaining concerns are mostly module size, naming clarity, and trust-boundary documentation rather than broken layering.

## Layer Map

| Layer | Primary Files | Responsibility |
| --- | --- | --- |
| Entry | `src/index.ts` | Yargs command surface, TUI lazy import, version, command dispatch. |
| CLI | `src/cli/*` | Plain REPL, one-shot runs, session listing, RAG command, stream rendering. |
| TUI | `src/tui/*` | OpenTUI/Solid UI, workflow picker, graph panels, config/plugin/RAG forms, controller state. |
| Session | `src/session.ts` | Conversation lifecycle, turn orchestration, compaction, persistence hooks, graph progress, runtime cleanup. |
| Runtime policy | `src/runtime/resolver.ts`, `src/runtime/services.ts`, `src/runtime/middleware.ts`, `src/runtime/toolPolicy.ts` | Config-to-run resolution, LangGraph runtime services, middleware assembly, tool filtering policy. |
| Engine | `src/engine/*` | DTO boundary, model construction, MCP pooling, tool assembly, agent build/cache, stream translation. |
| Workflows | `src/workflows/*` | Ruflo delegation, full audit graph, slim audit graph, subagent specs, workflow registry. |
| Resources | `src/resources/*` | Built-in tools and external resource management: web, network, terminal, RAG, skills, SkillHub. |
| Persistence/config | `src/config.ts`, `src/store.ts`, `src/paths.ts` | TOML config, global/workspace overlays, SQLite sessions/messages/tool traces/memory artifacts. |
| Context | `src/context/*` | Token estimation and structured context compaction. |
| Tests | `tests/*` | Unit and integration coverage for engine, runtime, config, RAG, TUI, session, CLI. |

## Main Runtime Flow

### TUI or CLI startup

1. `src/index.ts` installs debug handlers and loads `package.json` for CLI version output.
2. `loadConfig()` ensures global and workspace config directories, then merges global models/agents with global+workspace MCP and RAG overlays.
3. A command path is selected:
   - TUI: default command without `-c` or `--plain`.
   - Plain REPL: `--plain`.
   - One-shot: `-c` / `--message`.
   - Admin commands: `init`, `workflow`, `sessions`, `resume`, `rag`.

### One user turn

1. `Session.runTurn()` validates the active workflow and creates a conversation if needed.
2. `RuntimePolicyResolver.resolve(workflow)` produces a `RunPlan`:
   - primary provider DTO,
   - enabled MCP server DTOs,
   - resolved skill prompt and tool filters,
   - workflow/subagent model assignments,
   - subagent MCP allowlists,
   - RAG DTO.
3. `McpClientPool.connect()` connects configured MCP servers and keeps successful clients alive.
4. `Session.compactContext()` checks the model context budget and replaces older history with structured memory if needed.
5. `AgentRunner.run()` builds an `AgentRunConfig`, builds or reuses a compiled agent, and streams LangGraph chunks.
6. `EventTranslator` converts LangGraph message/update/custom chunks to `StreamEvent`s.
7. `Session` persists user/assistant messages and tool execution summaries into `Store`.
8. TUI or CLI renderers consume the same normalized event model.

### Agent construction

1. `AgentFactory.build()` validates model provider configuration.
2. It connects MCP tools through `McpClientPool`.
3. `ToolAssembler` appends built-in tools and applies skill allow/deny filtering.
4. `agentCacheKey()` decides whether a compiled agent can be reused.
5. `ModelFactory` creates the chat model.
6. `AgentFactory.createAgentForMode()` dispatches:
   - `ruflo`: LangChain `createAgent()` plus `delegate_task`.
   - `audit`: full LangGraph audit pipeline.
   - `audit-slim`: compact LangGraph audit pipeline.

## Key Boundaries And Decisions

### Config to engine boundary

The `src/engine/dto.ts` DTO classes are the intended boundary between config parsing and engine execution. This is a good separation: config files remain TOML-oriented and snake_case, while engine code receives normalized DTOs.

One caveat: `RuntimePolicyResolver` currently imports engine DTOs and prompt/model concepts from `engine`. That is acceptable for an adapter layer, but the `runtime/` name can make ownership look less clear than it is. If this area grows, consider a `planner/` or `policy/` package that explicitly owns config-to-engine adaptation.

### Workflow boundary

Workflow definitions are isolated under `src/workflows`, but `AgentFactory` still knows every workflow builder. That is workable because the set is small and workflow selection is central to agent creation. A workflow registry would be the next step if workflows become third-party extensions.

### Tool policy boundary

`ToolPolicy` filters explicit MCP and built-in tools by name. It does not attempt to tightly restrict deepagents shell/filesystem middleware. That is intentional for Sarma's use case: this is a high-automation local security tool expected to inspect files, run commands, operate debuggers, and interact with MCP servers.

Documented trust boundary:

- Run Sarma only in trusted workspaces.
- Treat installed skills and MCP servers as trusted code/config.
- Treat shell/filesystem middleware and persistent terminal tools as powerful local capabilities.
- Network tools can target arbitrary hosts; operators are responsible for authorization.

### Persistence boundary

Durable user-facing state is in workspace SQLite via `Store`. LangGraph checkpointer/store services are runtime-scoped in-memory helpers. This split is correct: runtime graph state can be recreated, while conversations, messages, tool traces, and memory artifacts survive restarts.

### Runtime lifecycle boundary

`Session` owns `McpClientPool`, `AgentRuntimeServices`, `AgentFactory`, active abort controller, graph state, and conversation state. This creates a clear lifecycle owner. Runtime restart cancels the current run, disconnects MCP, closes terminals, recreates services, and preserves history.

## Strengths

- Clear broad layering from entry/UI to session, policy resolution, engine, workflows, resources, and persistence.
- DTOs are used for cross-layer engine inputs.
- Streaming events provide a shared UI/CLI rendering contract.
- MCP degraded mode allows partial tool availability when one server fails.
- Persistent terminal lifecycle is session-owned and cleaned up on close.
- Configuration writes use TOML serialization and restrictive file permissions for secret-bearing files.
- Context compaction is model-window aware and persists structured memory.
- Test coverage is broad across runtime, engine, config, RAG, TUI, session, and CLI.
- Strict TypeScript settings and linting are present.

## Current Risks And Recommendations

### 1. `src/tui/controller.ts` is still a god object

The controller is over 3,000 lines and owns command parsing, session projection, config drafts, plugin state, RAG state, workflow graph views, and TUI action routing. Helper extractions exist, but the main module remains the highest-risk maintenance point.

Recommendation: split by surface:

- `tui/commands.ts`: slash command parsing and dispatch.
- `tui/sessionPresenter.ts`: stream/session/graph projections.
- `tui/configController.ts`: model and workflow config state.
- `tui/pluginController.ts`: MCP and skills state.
- `tui/ragController.ts`: RAG state and actions.

### 2. `resources/rag.ts` mixes several responsibilities

RAG currently combines knowledge-base config helpers, file walking, chunking, native SQLite storage, Chroma HTTP support, embeddings, scoring, and tool construction.

Recommendation: split into:

- `resources/rag/config.ts`
- `resources/rag/chunking.ts`
- `resources/rag/nativeStore.ts`
- `resources/rag/chromaHttp.ts`
- `resources/rag/search.ts`
- `resources/rag/tool.ts`

### 3. `config.ts` is large and schema-heavy

`config.ts` owns schema classes, default templates, parsing, merging, validation helpers, and saving. It is understandable today but will become difficult to extend as config grows.

Recommendation: keep the public exports stable, but move internals into `config/schema.ts`, `config/load.ts`, `config/save.ts`, and `config/defaults.ts`.

### 4. `AgentFactory` is a central workflow switch

The factory imports every graph builder and subagent spec. This keeps workflow assembly explicit, but new workflows require editing a central engine file.

Recommendation: introduce a workflow builder registry only when workflows become pluggable. Until then, central dispatch is simpler and acceptable.

### 5. Middleware tool count is static

`MIDDLEWARE_TOOL_COUNT = 13` is a static estimate used for context budgeting. It can drift from the actual tools exposed by dependency middleware versions.

Recommendation: add a runtime inspection path or a focused test that asserts the estimate is conservative enough for the installed middleware set.

### 6. MCP pool reconnect semantics are coarse

`McpClientPool` connects each server separately and supports degraded success, which is good. With the same fingerprint and failed servers, it reconnects the group rather than only failed servers.

Recommendation: acceptable for now. If connection costs become painful, keep successful per-server clients and retry only failed servers.

### 7. Runtime resolver name can obscure ownership

`RuntimePolicyResolver` is effectively the config-to-engine planner. It imports workflow metadata, skill loading, prompt building, engine DTOs, and config classes.

Recommendation: document it as the adapter boundary. If it grows, rename or relocate it to make the policy/planning role explicit.

### 8. High-automation trust boundary must remain visible

Broad local automation is a product requirement, not a defect. The real issue is making that boundary explicit for users and future maintainers.

Recommendation: keep documenting where tool filters apply, where they do not apply, and which capabilities assume a trusted local workspace.

