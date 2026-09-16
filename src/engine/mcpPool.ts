/** MCP client pool — persistent MultiServerMCPClient lifecycle management. */

import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { McpConnectionError } from "@/engine/errors";

export const DEFAULT_MCP_CONNECT_TIMEOUT = 20_000; // ms

/** Connection summary for one configured MCP server. */
export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error: string;
}

type ServerConfigs = Record<string, Record<string, unknown>>;

/** Stable serialization of server configs for equality comparison. */
function configFingerprint(configs: ServerConfigs): string {
  try {
    return stableStringify(configs);
  } catch {
    return "";
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as object).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

/** Connect timeout in ms = min(default, configured server timeouts). */
function connectTimeout(configs: ServerConfigs): number {
  const timeouts = [DEFAULT_MCP_CONNECT_TIMEOUT];
  for (const config of Object.values(configs)) {
    const t = config.timeout;
    if (typeof t === "number" && t > 0) {
      // Server timeouts are expressed in seconds (parity with Python config).
      timeouts.push(t * 1000);
    }
  }
  return Math.min(...timeouts);
}

function toolBelongsToServer(toolName: string, serverName: string): boolean {
  return (
    toolName === serverName ||
    toolName.startsWith(`${serverName}_`) ||
    toolName.startsWith(`${serverName}__`) ||
    toolName.startsWith(`${serverName}.`) ||
    toolName.startsWith(`${serverName}:`)
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Manages persistent MCP client connections.
 *
 * Lazy-connects on first tool request, keeps clients alive for reuse, and
 * provides health-check / reconnect on failure.
 */
export class McpClientPool {
  private clients = new Map<string, MultiServerMCPClient>();
  private toolsByServer = new Map<string, StructuredToolInterface[]>();
  private serverConfigs: ServerConfigs = {};
  private fingerprint = "";
  private toolList: StructuredToolInterface[] = [];
  private connected = false;
  private statuses = new Map<string, McpServerStatus>();
  /** Serializes connect/disconnect so concurrent callers cannot leak clients. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Bumped every time the pool actually rebuilds or extends its client set.
   * Compiled agents embed tool objects bound to the current clients, so agent
   * caches must key on this generation to avoid holding tools bound to closed
   * connections.
   */
  private generationCounter = 0;

  get isConnected(): boolean {
    return this.connected;
  }

  get generation(): number {
    return this.generationCounter;
  }

  get tools(): StructuredToolInterface[] {
    return [...this.toolList];
  }

  get serverStatuses(): McpServerStatus[] {
    return [...this.statuses.values()];
  }

  /**
   * Connect (or reconnect) to MCP servers and return available tools.
   *
   * @param serverConfigs map of server name → connection config, as produced
   *        by {@link McpServerDTO.toLangchainConfig}.
   */
  async connect(serverConfigs: ServerConfigs): Promise<StructuredToolInterface[]> {
    const run = this.queue.then(() => this.connectExclusive(serverConfigs));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Reconnect using the last known server configs. */
  async reconnect(): Promise<StructuredToolInterface[]> {
    if (Object.keys(this.serverConfigs).length === 0) return [];
    return this.connect(this.serverConfigs);
  }

  /** Cleanly close all MCP connections. */
  async disconnect(): Promise<void> {
    const run = this.queue.then(() => this.disconnectExclusive());
    this.queue = run.catch(() => {});
    return run;
  }

  private async connectExclusive(serverConfigs: ServerConfigs): Promise<StructuredToolInterface[]> {
    const fingerprint = configFingerprint(serverConfigs);
    if (this.connected && fingerprint && fingerprint === this.fingerprint && !this.hasFailedServers()) {
      return this.toolList;
    }

    // Same configuration with some failed servers: retry only the failed
    // ones. Tearing down healthy clients on every turn because one server
    // is down would rebuild the whole compiled agent graph each time.
    if (this.connected && fingerprint && fingerprint === this.fingerprint) {
      return this.reconnectFailedExclusive(serverConfigs);
    }

    await this.disconnectExclusive();
    this.generationCounter += 1;

    this.serverConfigs = { ...serverConfigs };
    this.fingerprint = fingerprint;
    this.statuses = new Map(
      Object.keys(serverConfigs).map((name) => [
        name,
        { name, connected: false, toolCount: 0, error: "" },
      ]),
    );

    if (Object.keys(serverConfigs).length === 0) {
      this.toolList = [];
      this.connected = true;
      return this.toolList;
    }

    const results = await Promise.all(
      Object.entries(serverConfigs).map(([name, config]) => connectOneServer(name, config)),
    );
    const errors = results.filter((result) => result.error).map((result) => result.error!);
    this.applyConnectResults(results);

    if (this.connected) return this.toolList;

    await this.disconnectExclusive();
    this.serverConfigs = { ...serverConfigs };
    this.statuses = new Map(results.map((result) => [result.status.name, result.status]));
    throw new McpConnectionError(Object.keys(serverConfigs).join(", "), errors.join("; "));
  }

  /** Retry the currently-failed servers, keeping healthy clients alive. */
  private async reconnectFailedExclusive(serverConfigs: ServerConfigs): Promise<StructuredToolInterface[]> {
    const failedNames = [...this.statuses.values()].filter((s) => !s.connected).map((s) => s.name);
    const results = await Promise.all(
      failedNames
        .filter((name) => serverConfigs[name] !== undefined)
        .map((name) => connectOneServer(name, serverConfigs[name]!)),
    );

    let recovered = false;
    for (const result of results) {
      this.statuses.set(result.status.name, result.status);
      if (result.client !== null) {
        this.clients.set(result.status.name, result.client);
        this.toolsByServer.set(result.status.name, result.tools);
        recovered = true;
      }
    }

    if (recovered) {
      // New client objects exist alongside the healthy ones; cached agents
      // must be rebuilt against the new tool set.
      this.generationCounter += 1;
      this.refreshToolList();
    }
    return this.toolList;
  }

  private applyConnectResults(results: ServerConnectResult[]): void {
    const statuses = new Map(results.map((result) => [result.status.name, result.status]));
    this.clients = new Map(
      results.flatMap((result) => (result.client ? [[result.status.name, result.client] as const] : [])),
    );
    this.toolsByServer = new Map(
      results.map((result) => [result.status.name, result.tools] as const),
    );
    this.statuses = statuses;
    this.refreshToolList();
    this.connected = this.clients.size > 0;
  }

  private refreshToolList(): void {
    this.toolList = [...this.toolsByServer.values()].flat();
  }

  private async disconnectExclusive(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        /* best-effort close */
      }
    }
    this.clients = new Map();
    this.toolsByServer = new Map();
    this.toolList = [];
    this.connected = false;
    this.fingerprint = "";
    this.statuses = new Map(
      Object.keys(this.serverConfigs).map((name) => [
        name,
        { name, connected: false, toolCount: 0, error: "" },
      ]),
    );
  }

  private hasFailedServers(): boolean {
    return [...this.statuses.values()].some((status) => !status.connected);
  }
}

interface ServerConnectResult {
  client: MultiServerMCPClient | null;
  tools: StructuredToolInterface[];
  status: McpServerStatus;
  error: string | null;
}

async function connectOneServer(name: string, config: Record<string, unknown>): Promise<ServerConnectResult> {
  const client = new MultiServerMCPClient({
    mcpServers: { [name]: config } as never,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "",
    throwOnLoadError: true,
  });
  try {
    const tools = (await withTimeout(
      client.getTools(),
      connectTimeout({ [name]: config }),
    )) as StructuredToolInterface[];
    return {
      client,
      tools,
      status: {
        name,
        connected: true,
        toolCount: tools.filter((tool) => toolBelongsToServer(tool.name ?? "", name)).length,
        error: "",
      },
      error: null,
    };
  } catch (exc) {
    // A timed-out / failed connect must not leak the underlying stdio child
    // process or HTTP session.
    try {
      await client.close();
    } catch {
      /* best-effort close */
    }
    const message = exc instanceof Error ? exc.message : String(exc);
    return {
      client: null,
      tools: [],
      status: { name, connected: false, toolCount: 0, error: message },
      error: `${name}: ${message}`,
    };
  }
}
