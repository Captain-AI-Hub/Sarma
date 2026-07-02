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
  private clients: MultiServerMCPClient[] = [];
  private serverConfigs: ServerConfigs = {};
  private fingerprint = "";
  private toolList: StructuredToolInterface[] = [];
  private connected = false;
  private statuses = new Map<string, McpServerStatus>();

  get isConnected(): boolean {
    return this.connected;
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
    const fingerprint = configFingerprint(serverConfigs);
    if (this.connected && fingerprint && fingerprint === this.fingerprint && !this.hasFailedServers()) {
      return this.toolList;
    }

    await this.disconnect();

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
    const tools = results.flatMap((result) => result.tools);
    const statuses = new Map(results.map((result) => [result.status.name, result.status]));
    const errors = results.filter((result) => result.error).map((result) => result.error!);
    const successCount = results.filter((result) => result.client !== null).length;
    this.clients = results.flatMap((result) => (result.client ? [result.client] : []));

    this.statuses = statuses;
    this.toolList = tools;
    this.connected = successCount > 0;
    if (this.connected) return this.toolList;

    await this.disconnect();
    this.serverConfigs = { ...serverConfigs };
    this.statuses = statuses;
    throw new McpConnectionError(Object.keys(serverConfigs).join(", "), errors.join("; "));
  }

  /** Reconnect using the last known server configs. */
  async reconnect(): Promise<StructuredToolInterface[]> {
    if (Object.keys(this.serverConfigs).length === 0) return [];
    return this.connect(this.serverConfigs);
  }

  /** Cleanly close all MCP connections. */
  async disconnect(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.close();
      } catch {
        /* best-effort close */
      }
    }
    this.clients = [];
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
  try {
    const client = new MultiServerMCPClient({
      mcpServers: { [name]: config } as never,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: "",
      throwOnLoadError: true,
    });
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
    const message = exc instanceof Error ? exc.message : String(exc);
    return {
      client: null,
      tools: [],
      status: { name, connected: false, toolCount: 0, error: message },
      error: `${name}: ${message}`,
    };
  }
}
