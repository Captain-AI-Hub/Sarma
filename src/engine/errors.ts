/** Runtime exceptions and error types. */

/** Base exception for Sarma runtime failures. */
class SarmaRuntimeError extends Error {
  constructor(message = "") {
    super(message);
    this.name = new.target.name;
  }
}

/** No model provider is configured or the selected one is invalid. */
export class ProviderNotConfiguredError extends SarmaRuntimeError {}

/** Failed to connect to an MCP server. */
export class McpConnectionError extends SarmaRuntimeError {
  readonly serverName: string;

  constructor(serverName: string, detail = "") {
    let msg = `MCP connection failed: ${serverName}`;
    if (detail) msg += ` — ${detail}`;
    super(msg);
    this.serverName = serverName;
  }
}

/** MCP server configuration is structurally invalid (missing url, bad JSON). */
export class McpValidationError extends SarmaRuntimeError {}

/** Failed to construct the LangGraph agent. */
export class AgentBuildError extends SarmaRuntimeError {}

/** Agent execution failed during streaming. */
export class AgentRunError extends SarmaRuntimeError {
  readonly recoverable: boolean;

  constructor(detail = "", recoverable = true) {
    super(detail);
    this.recoverable = recoverable;
  }
}
