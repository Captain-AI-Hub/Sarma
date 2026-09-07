/**
 * Slash-command status report builders.
 *
 * These functions format runtime/config state into plain-text reports. They
 * are extracted from the controller so the controller module only owns state
 * and actions; reports read state through this narrow dependency surface.
 */

import { type CliConfig, type McpServerConfig } from "@/config";
import type { RuntimePolicyResolver } from "@/runtime/resolver";
import type { Session } from "@/session";
import type { Store } from "@/store";
import * as paths from "@/paths";
import { listAvailableSkills } from "@/resources/skills";
import { knowledgeBaseChromaPath } from "@/resources/rag";
import { debugEnabled, debugLog, debugLogFile, setDebugEnabled } from "@/debug";

export interface ReportsDeps {
  config: CliConfig;
  /** Getter, not a value: the controller rebuilds the resolver on config save. */
  resolver: () => RuntimePolicyResolver;
  session: Session;
  store: Store;
  workflow: () => string;
  busy: () => boolean;
  stages: () => readonly { name: string; status: string }[];
  setToolCount: (count: number) => void;
  bumpMcpStatusVersion: () => void;
}

export function boolStatus(value: boolean): string {
  return value ? "enabled" : "disabled";
}

export function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

export function mcpTarget(server: McpServerConfig): string {
  if (server.transport === "stdio") return [server.command, server.args].filter(Boolean).join(" ");
  return server.url;
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value || "(unknown)";
  return d.toLocaleString();
}

export function createReports(deps: ReportsDeps) {
  const { config, session, store } = deps;

  async function reconnectMcpIfIdle(wf: string): Promise<string> {
    // While a turn is running, report current pool state only — reconnecting
    // would tear the pool down under the in-flight agent.
    if (deps.busy()) return "";
    try {
      await session.ensureMcpConnected(wf);
      deps.setToolCount(session.toolCount);
      deps.bumpMcpStatusVersion();
      return "";
    } catch (exc) {
      deps.bumpMcpStatusVersion();
      return exc instanceof Error ? exc.message : String(exc);
    }
  }

  async function statusReport(): Promise<string> {
    const wf = deps.workflow();
    const mcpError = await reconnectMcpIfIdle(wf);

    const provider = deps.resolver().providerFor(wf);
    const enabledServers = config.mcpServers.filter((server) => server.enabled);
    const statuses = session.poolRef.serverStatuses;
    const byName = new Map(statuses.map((s) => [s.name, s]));
    const skills = listAvailableSkills();
    const lines = [
      "status:",
      `  workflow: ${wf}`,
      `  model: ${provider.modelName || "(unset)"} via ${provider.name || "(unnamed)"}`,
      `  api mode: ${provider.apiMode}`,
      `  context: ${provider.maxContextTokens.toLocaleString()} tokens`,
      `  mcp: ${session.poolRef.isConnected && !mcpError ? "connected" : "not connected"}`,
      `  tools: ${session.toolCount}`,
      `  skills: ${formatList(skills)}`,
    ];

    if (enabledServers.length === 0) {
      lines.push("  servers: (none)");
    } else {
      lines.push("  servers:");
      for (const server of enabledServers) {
        const st = byName.get(server.name);
        const state = st?.connected ? "connected" : st?.error || mcpError ? "error" : "not connected";
        const detail = st?.error || (state === "error" ? mcpError : "");
        lines.push(
          `    - ${server.name}: ${state}, ${st?.toolCount ?? 0} tool(s)` +
            (detail ? ` (${detail})` : ""),
        );
      }
    }
    return lines.join("\n");
  }

  async function mcpReport(): Promise<string> {
    const wf = deps.workflow();
    const mcpError = await reconnectMcpIfIdle(wf);
    const statuses = session.poolRef.serverStatuses;
    const byName = new Map(statuses.map((s) => [s.name, s]));
    const lines = [
      "mcp:",
      `  workflow: ${wf}`,
      `  connected: ${session.poolRef.isConnected && !mcpError ? "yes" : "no"}`,
      `  tools: ${session.toolCount}`,
      `  local: ${paths.localMcpFile()}`,
      `  global: ${paths.globalMcpFile()}`,
      "  servers:",
    ];
    if (config.mcpServers.length === 0) {
      lines.push("    (none)");
    } else {
      for (const server of config.mcpServers) {
        const st = byName.get(server.name);
        const state = !server.enabled
          ? "disabled"
          : st?.connected
            ? "connected"
            : st?.error || mcpError
              ? "error"
              : "not connected";
        const detail = st?.error || (state === "error" ? mcpError : "");
        lines.push(
          `    - ${server.name}: ${server.transport}, ${state}, ${st?.toolCount ?? 0} tool(s)` +
            (detail ? ` (${detail})` : ""),
        );
      }
    }
    return lines.join("\n");
  }

  function graphReport(): string {
    const gs = session.graphState;
    const stageList = deps.stages();
    const lines = [
      "graph:",
      `  workflow: ${deps.workflow()}`,
      `  current: ${gs.current_stage || "(idle)"}`,
      `  completed: ${formatList([...gs.completed])}`,
      `  failed: ${gs.failed || "(none)"}`,
      `  gapfill loops: ${gs.gapfill_loops}`,
      `  feedback loops: ${gs.feedback_loops}`,
    ];
    if (stageList.length > 0) {
      lines.push("  stages:");
      for (const stage of stageList) lines.push(`    - ${stage.name}: ${stage.status}`);
    } else {
      lines.push("  stages: single-agent workflow");
    }
    return lines.join("\n");
  }

  function modelsReport(): string {
    const lines = ["models:"];
    for (const model of config.models) {
      const active = model.name === config.activeModel ? "*" : "-";
      lines.push(
        `  ${active} ${model.name}: ${model.modelName || "(unset)"} ` +
          `[${model.apiMode}, ${boolStatus(model.enabled)}, ${model.maxContextTokens.toLocaleString()} ctx]`,
      );
    }
    lines.push(`assignments for ${deps.workflow()}:`);
    for (const [agent, model] of deps.resolver().modelAssignmentsFor(deps.workflow())) {
      lines.push(`  - ${agent}: ${model}`);
    }
    return lines.join("\n");
  }

  function modelReport(): string {
    return [
      modelsReport(),
      "",
      "usage:",
      "  /model <name>   select the active model",
      "  /config         add or edit model providers",
    ].join("\n");
  }

  function agentSkillRows(): string[] {
    const wf = deps.workflow();
    const rows: string[] = [];
    for (const agent of config.agents) {
      if (agent.name === wf || agent.name.startsWith(`${wf}.`)) {
        rows.push(`    - ${agent.name}: ${formatList(agent.skills)}`);
      }
    }
    if (rows.length === 0) rows.push(`    - ${wf}: (none)`);
    return rows;
  }

  function skillsReport(): string {
    return [
      "skills:",
      `  installed: ${formatList(listAvailableSkills())}`,
      `  local: ${paths.localSkillsDir()}`,
      `  global: ${paths.globalSkillsDir()}`,
      `  workflow assignments (${deps.workflow()}):`,
      ...agentSkillRows(),
    ].join("\n");
  }

  function sessionsReport(limit = 20): string {
    const rows = store.listConversations(limit);
    if (rows.length === 0) return "sessions:\n  (no sessions yet)";
    const lines = ["sessions:"];
    for (const row of rows) {
      const title = row.title || "Untitled session";
      const model = row.model_name || "(unset)";
      lines.push(`  ${row.id}  ${title}  [${model}, ${row.status}, ${formatDate(row.updated_at)}]`);
    }
    return lines.join("\n");
  }

  function pluginReport(): string {
    const lines = [
      "plugins:",
      "  usage:",
      "    /plugin add mcp <name> <url-or-command> [--global]",
      "    /plugin add skill <name> [--global]",
      "    /plugin enable mcp <name>",
      "    /plugin disable mcp <name>",
      "    /plugin enable skill <name>",
      "    /plugin disable skill <name>",
      `  local mcp: ${paths.localMcpFile()}`,
      `  global mcp: ${paths.globalMcpFile()}`,
      `  local skills: ${paths.localSkillsDir()}`,
      `  global skills: ${paths.globalSkillsDir()}`,
      "  mcp servers:",
    ];
    if (config.mcpServers.length === 0) {
      lines.push("    (none)");
    } else {
      for (const server of config.mcpServers) {
        const target =
          server.transport === "stdio" ? [server.command, server.args].filter(Boolean).join(" ") : server.url;
        lines.push(
          `    - ${server.name}: ${server.transport}, ${boolStatus(server.enabled)}` +
            (target ? `, ${target}` : ""),
        );
      }
    }
    lines.push(`  skills: ${formatList(listAvailableSkills())}`);
    return lines.join("\n");
  }

  function ragReport(): string {
    const rag = config.rag;
    const lines = [
      "rag:",
      `  embedding_backend: ${rag.embeddingBackend}`,
      `  embedding_model: ${rag.embeddingModel || "(unset)"}`,
      `  embedding_api_base: ${rag.embeddingApiBase || "(unset)"}`,
      `  embedding_local_path: ${rag.embeddingLocalPath || "(default)"}`,
      `  chunk_size: ${rag.chunkSize}`,
      `  chunk_overlap: ${rag.chunkOverlap}`,
      "  knowledge_bases:",
    ];
    if (rag.knowledgeBases.length === 0) {
      lines.push("    (none)");
    } else {
      for (const kb of rag.knowledgeBases) {
        const target =
          kb.backend === "chroma_http"
            ? `${kb.chromaUrl || "(unset)"} collection=${kb.collectionName || kb.name || "(unset)"}`
            : knowledgeBaseChromaPath(kb);
        lines.push(
          `    - ${kb.name || "(unnamed)"}: ${boolStatus(kb.enabled)}, backend=${kb.backend}, ` +
            `docs=${kb.docsPath || "(default)"}, chroma=${target}`,
        );
      }
    }
    lines.push("  cli: sarma rag --help");
    return lines.join("\n");
  }

  function debugReport(arg = ""): string {
    const action = arg.trim().toLowerCase();
    if (["on", "enable", "enabled", "1", "true"].includes(action)) setDebugEnabled(true);
    if (["off", "disable", "disabled", "0", "false"].includes(action)) setDebugEnabled(false);
    debugLog("debug command invoked", { action: action || "status" });
    return [
      "debug:",
      `  enabled: ${debugEnabled() ? "yes" : "no"}`,
      `  log: ${debugLogFile()}`,
      "  usage: /debug on | /debug off | /debug",
      "  env: SARMA_DEBUG=1 SARMA_DEBUG_LOG=<path>",
    ].join("\n");
  }

  return {
    statusReport,
    mcpReport,
    graphReport,
    modelsReport,
    modelReport,
    skillsReport,
    sessionsReport,
    pluginReport,
    ragReport,
    debugReport,
  };
}
