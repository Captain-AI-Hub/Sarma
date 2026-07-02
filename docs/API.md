# Sarma API Reference

This document covers Sarma's public CLI/config surfaces and the main internal TypeScript APIs used by the runtime.

## Public CLI

Executable command: `sarma`

Development command: `bun run sarma`

### Root Options

| Option | Alias | Description |
| --- | --- | --- |
| `--message <text>` | `-c` | Run one non-interactive user message. |
| `--workflow <name>` | `-w` | Select workflow for this run: `ruflo`, `audit`, or `audit-slim`. |
| `--plain` | | Use the line-based REPL instead of the full-screen TUI. |
| `--help` | `-h` | Show CLI help. |
| `--version` | | Print package version from `package.json`. |

### Commands

| Command | Description |
| --- | --- |
| `sarma` | Start the full-screen TUI. |
| `sarma -c "message"` | Run one message and exit. |
| `sarma --plain` | Start the plain line-based REPL. |
| `sarma init` | Initialize global and workspace config files. |
| `sarma init --local` | Ensure workspace directories only. |
| `sarma workflow [name]` | List workflows or show how to run a specific workflow. |
| `sarma sessions [--limit N]` | List saved workspace sessions. |
| `sarma resume <sessionId>` | Resume a saved session in the TUI. |
| `sarma rag [options]` | Manage RAG model settings and knowledge bases. |

### RAG Command Options

| Option | Description |
| --- | --- |
| `--model <name>` | Set RAG embedding model name. |
| `--backend <huggingface|api>` | Set embedding backend. |
| `--api-base <url>` | Set OpenAI-compatible embedding API base URL. |
| `--api-key <key>` | Set embedding API key. |
| `--local-path <path>` | Set local embedding model path. |
| `--split <path>` | Chunk a file or directory into a Sarma native knowledge base. |
| `--add <pathOrUrl>` | Register an existing Sarma native DB directory or Chroma server URL. |
| `--name <name>` | Knowledge base name. |
| `--collection <name>` | Chroma collection name for server registration. |
| `--chroma-path <path>` | Output path for `--split`. |
| `--global` | Save knowledge base registration in global scope instead of workspace scope. |

## Slash Commands

The full-screen TUI supports the complete command set below. The plain REPL supports a smaller subset: `/help`, `/workflow`, `/clear`, and `/exit`.

| Command | Description |
| --- | --- |
| `/help` | Show command help. |
| `/status` | Show combined runtime status. |
| `/model [name]` | List or select active model. |
| `/config` | Configure model providers and workflow agents. |
| `/mcp` | Show MCP status. |
| `/skills` | Show skill status. |
| `/graph` | Open current workflow graph view. |
| `/graph status` | Print a copyable workflow graph report. |
| `/workflow [name]` | Open picker or switch workflow. |
| `/models` | Show configured models and assignments. |
| `/sessions` | List saved sessions. |
| `/resume <id>` | Resume a saved session. |
| `/plugin` | Configure MCP servers and skills. |
| `/rag` | Configure RAG settings and knowledge bases. |
| `/debug [on|off]` | Enable debug console/file logging. |
| `/restart` | Restart workflow runtime resources. |
| `/compact` | Compact conversation context. |
| `/clear` | Clear current session history. |
| `/exit` | Leave the TUI or REPL. |

## Configuration Files

Global directory: `~/.sarma`

Workspace directory: `./.sarma`

| File | Scope | Responsibility |
| --- | --- | --- |
| `~/.sarma/models.toml` | Global | Model providers and active model. |
| `~/.sarma/agents.toml` | Global | Workflow/subagent model, MCP, and skill routing. |
| `~/.sarma/mcp.toml` | Global | Shared MCP server definitions. |
| `./.sarma/mcp.toml` | Workspace | Workspace MCP definitions; same-name entries override global. |
| `~/.sarma/rag.toml` | Global | RAG embedding model settings and global knowledge bases. |
| `./.sarma/rag.toml` | Workspace | Workspace knowledge base registrations. |
| `~/.sarma/skills/<name>/SKILL.md` | Global | Global installed skill. |
| `./.sarma/skills/<name>/SKILL.md` | Workspace | Workspace installed skill, preferred over global same-name skill. |
| `./.sarma/db.sqlite` | Workspace | Durable sessions/messages/tool executions/memory artifacts. |
| `./.sarma/.history` | Workspace | TUI prompt history. |

### Model Config

```toml
active = "default"

[[models]]
name = "default"
model_name = "gpt-4o"
api_key = ""
base_url = ""
api_mode = "openai_compatible"
temperature = 0.0
top_p = 1.0
max_context_tokens = 128000
enabled = true
```

`api_mode` values:

- `openai_compatible`
- `openai_responses`
- `anthropic`

`max_context_tokens` accepts numbers and shorthand such as `200K`, `1M`, or `1.5M`.

### Agent Config

```toml
[[agents]]
name = "ruflo"
model = "default"
mcp = ["*"]
skills = []

[[agents]]
name = "audit.recon"
model = "default"
mcp = ["ida-mcp"]
skills = ["*"]
```

Agent names can target a workflow (`ruflo`, `audit`, `audit-slim`) or a workflow subagent (`audit.recon`, `audit-slim.verify`). `mcp = ["*"]` allows all enabled MCP servers. `skills = ["*"]` loads all available skills.

### MCP Config

```toml
[[mcp_servers]]
name = "ida-mcp"
transport = "http"
url = "http://127.0.0.1:8000/mcp"
enabled = true
```

Supported transport values:

- `stdio`
- `http`
- `sse`

Stdio entries can also define `command`, `args`, `env`, `cwd`, and `encoding`. HTTP/SSE entries can define `url`, `headers`, `timeout`, and `sse_read_timeout`.

### RAG Config

```toml
embedding_backend = "api"
embedding_model = "text-embedding-3-large"
embedding_api_base = ""
embedding_api_key = ""
embedding_local_path = ""
chunk_size = 1200
chunk_overlap = 150

[[knowledge_bases]]
name = "project-docs"
backend = "sarma_native"
docs_path = ""
chroma_path = ""
enabled = true
```

Knowledge base backend values:

- `sarma_native`: Bun SQLite chunk database stored in a Chroma-style directory containing `chroma.sqlite3`.
- `chroma_http`: external Chroma server accessed over HTTP.

## Workflows

| Workflow | Internal Mode | Subagents |
| --- | --- | --- |
| `ruflo` | ReAct primary agent with `delegate_task` | None registered as workflow stages. |
| `audit` | Full LangGraph vulnerability audit pipeline | `recon`, `hunt`, `validate`, `gapfill`, `dedupe`, `trace`, `feedback`, `report`. |
| `audit-slim` | Compact LangGraph audit pipeline | `recon`, `hunter`, `verify`, `report`. |

## Built-In Agent Tools

| Tool | Owner | Purpose |
| --- | --- | --- |
| `web_search` | `resources/webTools.ts` | Public web search with compact results. |
| `fetch_url` | `resources/webTools.ts` | Fetch HTTP/HTTPS URL and return readable content. |
| `http_exchange` | `resources/networkTools.ts` | Send structured HTTP/HTTPS requests to target host/port/path. |
| `packet_exchange` | `resources/networkTools.ts` | Send raw TCP, UDP, or TLS payloads and capture response. |
| `rag_search` | `resources/rag.ts` | Search enabled RAG knowledge bases. Mounted only when at least one enabled KB exists. |

Persistent terminal middleware tools:

- `terminal_start`
- `terminal_write`
- `terminal_read`
- `terminal_stop`
- `terminal_list`

Deepagents filesystem/shell middleware also exposes local workspace file and command capabilities. These are intentionally broad for high-automation local audit work and are not governed by `ToolPolicy` name filtering.

## Stream Event API

Class: `StreamEvent` in `src/engine/models.ts`

```ts
interface StreamEventInit {
  type: string;
  conversationId?: string;
  turnId?: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
}
```

Event type constants are defined in `src/engine/enums.ts`:

| Type | Meaning |
| --- | --- |
| `token` | Assistant token/content chunk. |
| `tool_start` | Tool call started. |
| `tool_result` | Tool call returned. |
| `tool_error` | Tool call failed. |
| `run_started` | User turn started. |
| `run_completed` | User turn completed. |
| `run_failed` | User turn failed or was cancelled. |
| `skill_triggered` | Skill activation event. |
| `stage_start` | Audit workflow stage started. |
| `stage_complete` | Audit workflow stage completed. |
| `stage_error` | Audit workflow stage failed. |
| `subagent_start` | Subagent started. |
| `subagent_complete` | Subagent completed. |
| `subagent_error` | Subagent failed. |
| `custom_progress` | Workflow-specific progress payload. |

## Internal TypeScript API

These are internal code APIs, not semver-stable public package APIs.

### `Session`

File: `src/session.ts`

Primary methods:

- `setWorkflow(name: string): void`
- `ensureMcpConnected(workflow: string): Promise<void>`
- `restartRuntime(): Promise<void>`
- `cancelCurrentRun(): boolean`
- `newConversation(title?: string): string`
- `resumeConversation(cid: string): boolean`
- `compactContext(options): Promise<boolean>`
- `runTurn(userMessage: string): AsyncIterableIterator<StreamEvent>`
- `close(): Promise<void>`

Responsibility: owns one live runtime session and coordinates config resolution, MCP, agent execution, context compaction, graph progress, persistence, cancellation, and cleanup.

### `RuntimePolicyResolver`

File: `src/runtime/resolver.ts`

Primary methods:

- `providerFor(workflow: string, subagent?: string | null): ProviderConfig`
- `modelAssignmentsFor(workflow: string): [string, string][]`
- `resolve(workflow: string): RunPlan`

Responsibility: converts effective `CliConfig` into a concrete per-turn `RunPlan` with DTOs and resolved skill/tool/model/MCP policy.

### `AgentFactory`

File: `src/engine/agentFactory.ts`

Primary method:

- `build(config: AgentRunConfig): Promise<[compiledAgent, tools]>`

Responsibility: validates provider setup, connects MCP, assembles tools, initializes model, selects workflow builder, and caches compiled agents.

### `AgentRunner`

File: `src/engine/agentRunner.ts`

Primary members:

- `run(message: string): AsyncIterableIterator<StreamEvent>`
- `finalContent: string`
- `reasoningContent: string`
- `toolCalls: StreamEvent[]`

Responsibility: runs one turn on a compiled graph/agent and converts raw LangGraph streaming into normalized events.

### `McpClientPool`

File: `src/engine/mcpPool.ts`

Primary members:

- `connect(serverConfigs): Promise<StructuredToolInterface[]>`
- `reconnect(): Promise<StructuredToolInterface[]>`
- `disconnect(): Promise<void>`
- `tools: StructuredToolInterface[]`
- `serverStatuses: McpServerStatus[]`

Responsibility: manages persistent MCP client connections and degraded per-server status.

### `AgentRuntimeServices`

File: `src/runtime/services.ts`

Primary members:

- `checkpointer`
- `store`
- `terminalManager`
- `compileKwargs()`
- `createAgentKwargs()`
- `setConversationId(conversationId)`
- `close()`

Responsibility: owns runtime-scoped LangGraph services and terminal lifecycle.

### DTOs

File: `src/engine/dto.ts`

DTO classes:

- `ModelProviderDTO`
- `McpServerDTO`
- `KnowledgeBaseDTO`
- `RagConfigDTO`

Responsibility: normalized cross-layer values passed from runtime/config planning into engine execution.

### Runtime tool policy

File: `src/runtime/toolPolicy.ts`

Primary exports:

- `BUILTIN_TOOL_NAMES`
- `MIDDLEWARE_TOOL_COUNT`
- `builtinToolCount(rag)`
- `runtimeStaticToolCount(rag)`
- `filterToolsBySkill(tools, skill)`
- `filterToolsByMcpServers(tools, allowedServers)`
- `filterToolsByPrefixes(tools, prefixes)`

Responsibility: central registry and filtering rules for explicit MCP and built-in tools.

### Store

File: `src/store.ts`

Primary methods:

- `createConversation(title?, modelName?)`
- `updateConversation(cid, fields)`
- `listConversations(limit?)`
- `getConversation(cid)`
- `saveMessage(...)`
- `replaceMessages(conversationId, messages)`
- `loadMessages(conversationId)`
- `saveMemoryArtifact(...)`
- `loadMemoryArtifacts(conversationId, limit?)`
- `saveToolExecution(...)`
- `finishToolExecution(...)`
- `close()`

Responsibility: workspace SQLite persistence.

## Trust Boundary

Sarma is designed for trusted local security automation. It can read/write workspace files, run commands, launch persistent processes, call configured MCP servers, use installed skill prompts, and send network probes. Tool allow/deny lists govern explicit MCP and built-in tools; they are not a sandbox for all runtime capabilities.

