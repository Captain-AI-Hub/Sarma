import { createAgent } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { loadConfig } from "@/config";
import { createTokenEstimator } from "@/context/tokenizer";
import type { ModelProviderDTO } from "@/engine/dto";
import { McpClientPool } from "@/engine/mcpPool";
import { ModelFactory } from "@/engine/modelFactory";
import { buildHttpExchangeTool, buildPacketExchangeTool } from "@/resources/networkTools";
import { buildFetchUrlTool, buildWebSearchTool } from "@/resources/webTools";
import { buildAgentMiddlewareForModel } from "@/runtime/middleware";
import { RuntimePolicyResolver, type RunPlan } from "@/runtime/resolver";
import { AgentRuntimeServices } from "@/runtime/services";
import { filterToolsBySkill } from "@/runtime/toolPolicy";
import { buildAuditGraph } from "@/workflows/auditGraph";
import { AUDIT_SUBAGENTS } from "@/workflows/auditSubagents";
import { buildAuditSlimGraph } from "@/workflows/auditSlimGraph";
import { AUDIT_SLIM_SUBAGENTS } from "@/workflows/auditSlimSubagents";
import { buildAnalysisGraph } from "@/workflows/analysisGraph";
import { ANALYSIS_SUBAGENTS } from "@/workflows/analysisSubagents";
import { buildDelegateTool } from "@/workflows/ruflo";

const STUDIO_CONVERSATION_ID = "langgraph-studio";
const ENABLE_MCP = process.env.SARMA_LANGGRAPH_ENABLE_MCP === "true";

type WorkflowName = "ruflo" | "audit" | "audit-slim" | "analysis";
type CompiledGraph = Record<string, unknown>;

const config = loadConfig();
const resolver = new RuntimePolicyResolver(config);
const modelFactory = new ModelFactory();

function builtinTools(): StructuredToolInterface[] {
  return [
    buildWebSearchTool(),
    buildFetchUrlTool(),
    buildHttpExchangeTool(),
    buildPacketExchangeTool(),
  ];
}

function subagentModels(plan: RunPlan): Record<string, BaseChatModel> {
  const models: Record<string, BaseChatModel> = {};
  for (const [name, provider] of Object.entries(plan.subagentProviders)) {
    if (name === "orchestrator") continue;
    models[name] = modelFactory.initModel(provider as ModelProviderDTO, null);
  }
  return models;
}

/**
 * One shared MCP pool for all exported graphs (each `buildWorkflowGraph`
 * connects the same server set; separate pools would leak one stdio child
 * per graph for the process lifetime). Disconnected on process shutdown.
 */
const studioPool = new McpClientPool();
process.on("beforeExit", () => {
  void studioPool.disconnect().catch(() => {});
});

async function toolsForPlan(plan: RunPlan): Promise<StructuredToolInterface[]> {
  let mcpTools: StructuredToolInterface[] = [];
  if (ENABLE_MCP && plan.enabledServers.length > 0) {
    const serverConfigs: Record<string, Record<string, unknown>> = {};
    for (const server of plan.enabledServers) {
      serverConfigs[server.name] = server.toLangchainConfig();
    }
    mcpTools = await studioPool.connect(serverConfigs);
  }
  return filterToolsBySkill([...mcpTools, ...builtinTools()], plan.skill);
}

async function buildWorkflowGraph(mode: WorkflowName): Promise<CompiledGraph> {
  const plan = resolver.resolve(mode);
  const conversationId = `${STUDIO_CONVERSATION_ID}-${mode}`;
  const runtimeServices = AgentRuntimeServices.create();
  runtimeServices.setConversationId(conversationId);

  const model = modelFactory.initModel(plan.provider, plan.skill);
  const tools = await toolsForPlan(plan);

  if (mode === "ruflo") {
    const rufloTools = [
      ...tools,
      buildDelegateTool(model, tools, {
        conversationId,
        terminalManager: runtimeServices.terminalManager,
      }),
    ];
    const graph = createAgent({
      model,
      tools: rufloTools,
      systemPrompt: plan.systemPrompt,
      middleware: buildAgentMiddlewareForModel(model, {
        conversationId,
        terminalManager: runtimeServices.terminalManager,
      }),
      ...runtimeServices.createAgentKwargs(),
    }) as unknown as CompiledGraph;
    graph.name = mode;
    return graph;
  }

  const subModels = subagentModels(plan);
  const commonOptions = {
    systemPrompt: plan.systemPrompt,
    subagentModels: Object.keys(subModels).length ? subModels : null,
    subagentMcpAllow: plan.subagentMcpAllow,
    subagentSkills: plan.subagentSkills,
    maxPriorStageTokens: Math.max(
      12_000,
      Math.min(120_000, Math.trunc((plan.provider.maxContextTokens || 128_000) * 0.35)),
    ),
    estimateText: createTokenEstimator(plan.provider),
    compileKwargs: runtimeServices.compileKwargs(),
    conversationId,
    terminalManager: runtimeServices.terminalManager,
  };

  const graph =
    mode === "audit-slim"
      ? buildAuditSlimGraph(model, tools, {
          ...commonOptions,
          subagentSpecs: AUDIT_SLIM_SUBAGENTS,
        })
      : mode === "analysis"
        ? buildAnalysisGraph(model, tools, {
            ...commonOptions,
            subagentSpecs: ANALYSIS_SUBAGENTS,
          })
        : buildAuditGraph(model, tools, {
            ...commonOptions,
            subagentSpecs: AUDIT_SUBAGENTS,
          });
  (graph as unknown as CompiledGraph).name = mode;
  return graph as unknown as CompiledGraph;
}

// Build all graphs concurrently (they share one MCP pool connect through the
// serialized queue). Note: a fatal config error still fails the whole module —
// LangGraph Studio expects real compiled graphs, so a broken stub would be
// worse than a loud load failure.
const [rufloGraph, auditGraph, auditSlimGraph, analysisGraph] = await Promise.all([
  buildWorkflowGraph("ruflo"),
  buildWorkflowGraph("audit"),
  buildWorkflowGraph("audit-slim"),
  buildWorkflowGraph("analysis"),
]);

export const ruflo = rufloGraph;
export const audit = auditGraph;
export const auditSlim = auditSlimGraph;
export const analysis = analysisGraph;
