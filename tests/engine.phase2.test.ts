import { expect, test, describe } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { McpClientPool } from "@/engine/mcpPool";
import { ModelFactory } from "@/engine/modelFactory";
import { ProviderNotConfiguredError } from "@/engine/errors";
import { KnowledgeBaseDTO, McpServerDTO, ModelProviderDTO, RagConfigDTO } from "@/engine/dto";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import {
  startHttpMcpServer,
  startSseMcpServer,
  stdioServerScriptPath,
} from "./fixtures/mockMcpServers";
import { ResolvedSkill } from "@/engine/models";
import { AgentFactory } from "@/engine/agentFactory";
import { makeAgentRunConfig } from "@/engine/models";
import { filterToolsBySkill } from "@/runtime/toolPolicy";

function provider(overrides: Partial<ConstructorParameters<typeof ModelProviderDTO>[0]> = {}) {
  return new ModelProviderDTO({
    id: 1,
    name: "default",
    modelName: "gpt-4o-mini",
    apiMode: "openai_compatible",
    apiKey: "sk-test",
    baseUrl: "",
    temperature: 0,
    topP: 1,
    maxContextTokens: 128000,
    enabled: true,
    ...overrides,
  });
}

describe("ModelFactory", () => {
  const factory = new ModelFactory();

  test("openai_compatible builds ChatOpenAI", () => {
    const m = factory.initModel(provider());
    expect(m).toBeInstanceOf(ChatOpenAI);
  });

  test("openai_responses sets useResponsesApi", () => {
    const m = factory.initModel(provider({ apiMode: "openai_responses" })) as ChatOpenAI;
    expect(m).toBeInstanceOf(ChatOpenAI);
    expect(m.useResponsesApi).toBe(true);
  });

  test("anthropic builds ChatAnthropic", () => {
    const m = factory.initModel(provider({ apiMode: "anthropic", modelName: "claude-x" }));
    expect(m).toBeInstanceOf(ChatAnthropic);
  });

  test("unknown api_mode throws", () => {
    expect(() => factory.initModel(provider({ apiMode: "bogus" }))).toThrow(ProviderNotConfiguredError);
  });

  test("skill preferred model + temperature override applied", () => {
    const skill = new ResolvedSkill({
      name: "s",
      preferredModelName: "deepseek-reasoner",
      temperatureOverride: 0.5,
    });
    const m = factory.initModel(provider(), skill) as ChatOpenAI;
    expect(m.model).toBe("deepseek-reasoner");
    expect(m.temperature).toBe(0.5);
  });
});

describe("McpClientPool", () => {
  test("empty config connects with no tools", async () => {
    const pool = new McpClientPool();
    const tools = await pool.connect({});
    expect(tools).toEqual([]);
    expect(pool.isConnected).toBe(true);
  });
});

describe("ToolPolicy", () => {
  test("filterToolsBySkill applies allow then deny", () => {
    const fakeTools = [
      { name: "ida__decompile" },
      { name: "ida__disasm" },
      { name: "ida__patch_bytes" },
    ] as never[];
    const allowed = filterToolsBySkill(
      fakeTools,
      new ResolvedSkill({
        toolAllowlist: new Set(["ida__decompile", "ida__disasm", "ida__patch_bytes"]),
        toolDenylist: new Set(["ida__patch_bytes"]),
      }),
    );
    expect(allowed.map((t) => (t as { name: string }).name)).toEqual([
      "ida__decompile",
      "ida__disasm",
    ]);
  });

  test("null allowlist allows all", () => {
    const fakeTools = [{ name: "a" }, { name: "b" }] as never[];
    expect(filterToolsBySkill(fakeTools, null).length).toBe(2);
  });
});

function mcpServer(overrides: Partial<ConstructorParameters<typeof McpServerDTO>[0]> = {}) {
  return new McpServerDTO({
    id: null,
    name: "mock",
    transport: "http",
    enabled: true,
    command: "",
    args: "",
    env: "",
    cwd: "",
    encoding: "utf-8",
    url: "http://127.0.0.1:65535/mcp",
    headers: "",
    timeout: 60,
    sseReadTimeout: 300,
    ...overrides,
  });
}

// These guard the Python→JS adapter contract mismatch: the JS connection
// schema only accepts transport "http"/"sse"/"stdio" (NOT "streamable_http"),
// requires stdio `args` to be an array, and has no sseReadTimeout field.
describe("McpServerDTO.toLangchainConfig() — JS adapter contract", () => {
  test("http transport stays 'http' (not Python's streamable_http)", () => {
    const cfg = mcpServer({ transport: "http", url: "http://127.0.0.1:65535/mcp" }).toLangchainConfig();
    expect(cfg.transport).toBe("http");
    expect(cfg.url).toBe("http://127.0.0.1:65535/mcp");
    expect(cfg).not.toHaveProperty("sseReadTimeout");
  });

  test("legacy 'streamable_http' is normalized to 'http'", () => {
    const cfg = mcpServer({ transport: "streamable_http" }).toLangchainConfig();
    expect(cfg.transport).toBe("http");
  });

  test("stdio always emits an args array even when unconfigured", () => {
    const cfg = mcpServer({ transport: "stdio", command: "node", args: "" }).toLangchainConfig();
    expect(cfg.transport).toBe("stdio");
    expect(cfg.command).toBe("node");
    expect(cfg.args).toEqual([]);
  });

  test("malformed stdio args JSON throws a diagnostic error", () => {
    expect(() => mcpServer({ transport: "stdio", command: "node", args: "[bad" }).toLangchainConfig()).toThrow(
      "Invalid args JSON",
    );
  });

  test("malformed http headers JSON throws a diagnostic error", () => {
    expect(() => mcpServer({ transport: "http", headers: "{bad" }).toLangchainConfig()).toThrow(
      "Invalid headers JSON",
    );
  });

  // Constructing MultiServerMCPClient runs the adapter's zod validation, so an
  // accepted config proves the contract holds without needing a live server.
  test("http config is accepted by MultiServerMCPClient", () => {
    const cfg = mcpServer({ transport: "http" }).toLangchainConfig();
    expect(
      () =>
        new MultiServerMCPClient({
          mcpServers: { mock: cfg } as never,
          prefixToolNameWithServerName: true,
          additionalToolNamePrefix: "",
          throwOnLoadError: true,
        }),
    ).not.toThrow();
  });

  test("stdio config is accepted by MultiServerMCPClient", () => {
    const cfg = mcpServer({ transport: "stdio", command: "node", args: "" }).toLangchainConfig();
    expect(
      () =>
        new MultiServerMCPClient({
          mcpServers: { mock: cfg } as never,
          throwOnLoadError: true,
        }),
    ).not.toThrow();
  });
});

// Live end-to-end tests, one per transport. Each spins up a self-contained MCP
// server (official @modelcontextprotocol/sdk) exposing a `ping` tool, then
// drives it through the real DTO → McpClientPool.connect() → tools path. All
// servers bind to an OS-assigned ephemeral port (or a spawned child for stdio),
// so no externally installed/running MCP server (e.g. IDA-MCP) is required.
describe("McpClientPool.connect() — live servers (all transports)", () => {
  test("http transport returns prefixed tools", async () => {
    const srv = await startHttpMcpServer();
    const pool = new McpClientPool();
    try {
      const dto = mcpServer({ name: "svc", transport: "http", url: srv.url });
      const tools = await pool.connect({ svc: dto.toLangchainConfig() });
      expect(tools.map((t) => t.name)).toEqual(["svc__ping"]);
      expect(pool.isConnected).toBe(true);
      const status = pool.serverStatuses.find((s) => s.name === "svc");
      expect(status?.connected).toBe(true);
      expect(status?.toolCount).toBe(1);
    } finally {
      await pool.disconnect();
      await srv.close();
    }
  });

  test("sse transport returns prefixed tools", async () => {
    const srv = await startSseMcpServer();
    const pool = new McpClientPool();
    try {
      const dto = mcpServer({ name: "svc", transport: "sse", url: srv.url });
      const tools = await pool.connect({ svc: dto.toLangchainConfig() });
      expect(tools.map((t) => t.name)).toEqual(["svc__ping"]);
      expect(pool.isConnected).toBe(true);
    } finally {
      await pool.disconnect();
      await srv.close();
    }
  });

  test("stdio transport returns prefixed tools", async () => {
    const pool = new McpClientPool();
    try {
      const dto = mcpServer({
        name: "svc",
        transport: "stdio",
        command: process.execPath, // bun
        args: JSON.stringify([stdioServerScriptPath()]),
      });
      const tools = await pool.connect({ svc: dto.toLangchainConfig() });
      expect(tools.map((t) => t.name)).toEqual(["svc__ping"]);
      expect(pool.isConnected).toBe(true);
    } finally {
      await pool.disconnect();
    }
  });

  test("degraded mode keeps healthy servers when another server fails", async () => {
    const srv = await startHttpMcpServer();
    const pool = new McpClientPool();
    try {
      const good = mcpServer({ name: "good", transport: "http", url: srv.url });
      const bad = mcpServer({ name: "bad", transport: "http", url: "http://127.0.0.1:1/mcp", timeout: 0.1 });
      const tools = await pool.connect({
        good: good.toLangchainConfig(),
        bad: bad.toLangchainConfig(),
      });
      expect(tools.map((t) => t.name)).toEqual(["good__ping"]);
      expect(pool.isConnected).toBe(true);
      expect(pool.serverStatuses.find((s) => s.name === "good")?.connected).toBe(true);
      const badStatus = pool.serverStatuses.find((s) => s.name === "bad");
      expect(badStatus?.connected).toBe(false);
      expect(badStatus?.error).not.toBe("");
    } finally {
      await pool.disconnect();
      await srv.close();
    }
  });

  test("degraded same-fingerprint reconnect retries previously failed servers", async () => {
    const first = await startHttpMcpServer();
    const reservation = await startHttpMcpServer();
    const retryUrl = reservation.url;
    const retryPort = Number(new URL(retryUrl).port);
    await reservation.close();
    const pool = new McpClientPool();
    try {
      const dto = mcpServer({ name: "svc", transport: "http", url: first.url });
      const configs = {
        svc: dto.toLangchainConfig(),
        bad: mcpServer({ name: "bad", transport: "http", url: retryUrl, timeout: 0.1 }).toLangchainConfig(),
      };
      await pool.connect(configs);
      expect(pool.serverStatuses.find((s) => s.name === "bad")?.connected).toBe(false);

      const second = await startHttpMcpServer(retryPort);
      try {
        const tools = await pool.connect(configs);
        expect(tools.map((t) => t.name).sort()).toEqual(["bad__ping", "svc__ping"]);
        expect(pool.serverStatuses.every((status) => status.connected)).toBe(true);
      } finally {
        await second.close();
      }
    } finally {
      await pool.disconnect();
      await first.close();
    }
  });
});

describe("AgentFactory tool policy", () => {
  test("skill allowlist filters MCP and built-in tools through one policy", async () => {
    const factory = new AgentFactory(new McpClientPool(), { runtimeServices: null });
    const skill = new ResolvedSkill({
      name: "web-only",
      toolAllowlist: new Set(["web_search"]),
    });
    const [, tools] = await factory.build(
      makeAgentRunConfig({
        conversationId: "c",
        provider: provider(),
        userMessage: "q",
        mode: "ruflo",
        skill,
      }),
    );
    expect(tools.map((t) => t.name)).toEqual(["web_search"]);
  });

  test("RAG path changes invalidate cached agents", async () => {
    const factory = new AgentFactory(new McpClientPool(), { runtimeServices: null });
    const runConfig = (chromaPath: string) =>
      makeAgentRunConfig({
        conversationId: "c",
        provider: provider(),
        userMessage: "q",
        mode: "ruflo",
        rag: new RagConfigDTO({
          knowledgeBases: [
            new KnowledgeBaseDTO({
              name: "docs",
              docsPath: "",
              backend: "sarma_native",
              chromaPath,
              chromaUrl: "",
              collectionName: "",
              tenant: "",
              database: "",
              headers: "",
              enabled: true,
            }),
          ],
        }),
      });

    const [firstAgent] = await factory.build(runConfig("/tmp/a"));
    const [secondAgent] = await factory.build(runConfig("/tmp/b"));

    expect(secondAgent).not.toBe(firstAgent);
  });
});
