/** LangGraph agent factory. */

import { createAgent } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { AgentBuildError, ProviderNotConfiguredError } from "@/engine/errors";
import { McpClientPool } from "@/engine/mcpPool";
import { type AgentRunConfig } from "@/engine/models";
import { ModelFactory } from "@/engine/modelFactory";
import type { ModelProviderDTO } from "@/engine/dto";
import { buildAgentMiddlewareForModel } from "@/runtime/middleware";
import { AgentRuntimeServices } from "@/runtime/services";
import { ToolAssembler } from "@/engine/toolAssembler";
import { agentCacheKey } from "@/engine/agentCacheKey";
import { buildAuditGraph } from "@/workflows/auditGraph";
import { AUDIT_SUBAGENTS } from "@/workflows/auditSubagents";
import { buildAuditSlimGraph } from "@/workflows/auditSlimGraph";
import { AUDIT_SLIM_SUBAGENTS } from "@/workflows/auditSlimSubagents";
import { buildDelegateTool } from "@/workflows/ruflo";
import { createTokenEstimator } from "@/context/tokenizer";

type CompiledAgent = { stream: (...args: unknown[]) => AsyncIterable<unknown> } & Record<string, unknown>;
type BuildResult = [CompiledAgent, StructuredToolInterface[]];

/** Builds a LangGraph agent from runtime configuration. */
export class AgentFactory {
  private readonly modelFactory: ModelFactory;
  private readonly runtimeServices: AgentRuntimeServices | null;
  private readonly toolAssembler: ToolAssembler;
  private readonly agentCache = new Map<string, BuildResult>();
  private readonly agentCacheLimit = 8;

  constructor(
    private readonly pool: McpClientPool,
    options: {
      workspacePath?: string;
      modelFactory?: ModelFactory;
      runtimeServices?: AgentRuntimeServices | null;
      toolAssembler?: ToolAssembler;
    } = {},
  ) {
    this.modelFactory = options.modelFactory ?? new ModelFactory();
    this.runtimeServices = options.runtimeServices ?? null;
    this.toolAssembler = options.toolAssembler ?? new ToolAssembler();
  }

  /** Build and return [compiledGraph, tools]. */
  async build(config: AgentRunConfig): Promise<BuildResult> {
    const provider = config.provider;
    if (!provider.modelName) {
      throw new ProviderNotConfiguredError("Model name is required for the selected provider.");
    }

    // 1. Build MCP server configs from enabled servers.
    const serverConfigs: Record<string, Record<string, unknown>> = {};
    for (const server of config.enabledServers) {
      serverConfigs[server.name] = server.toLangchainConfig();
    }

    // 2. Connect / reuse MCP client pool and get tools.
    const allTools = await this.pool.connect(serverConfigs);

    // 3. Apply one shared policy to MCP and built-in tools.
    const tools = this.toolAssembler.assemble(allTools, config);

    const cacheKey = agentCacheKey(config, serverConfigs, tools);
    const cached = this.agentCache.get(cacheKey);
    if (cached !== undefined) return cached;

    // 4. Initialize LLM.
    let model: BaseChatModel;
    try {
      model = this.modelFactory.initModel(provider, config.skill);
    } catch (exc) {
      throw new AgentBuildError(`Failed to initialize model: ${exc instanceof Error ? exc.message : exc}`);
    }

    // 5. Build agent (audit pipelines vs ruflo primary + delegation).
    let agent: CompiledAgent;
    try {
      agent = this.createAgentForMode(config, model, tools);
    } catch (exc) {
      throw new AgentBuildError(`Failed to create agent: ${exc instanceof Error ? exc.message : exc}`);
    }

    const result: BuildResult = [agent, tools];
    this.agentCache.set(cacheKey, result);
    if (this.agentCache.size > this.agentCacheLimit) {
      const firstKey = this.agentCache.keys().next().value;
      if (firstKey !== undefined) this.agentCache.delete(firstKey);
    }
    return result;
  }

  private createAgentForMode(
    config: AgentRunConfig,
    model: BaseChatModel,
    tools: StructuredToolInterface[],
  ): CompiledAgent {
    if (config.mode === "audit" || config.mode === "audit-slim") {
      const subagentModels = this.loadSubagentModels(config.subagentProviders);
      delete subagentModels.orchestrator;
      const compileKwargs = this.runtimeServices?.compileKwargs() ?? {};
      const maxPriorStageTokens = Math.max(
        12_000,
        Math.min(120_000, Math.trunc((config.provider.maxContextTokens || 128_000) * 0.35)),
      );
      const estimateText = createTokenEstimator(config.provider);

      if (config.mode === "audit-slim") {
        return buildAuditSlimGraph(model, tools, {
          systemPrompt: config.systemPrompt || "",
          subagentSpecs: AUDIT_SLIM_SUBAGENTS,
          subagentModels: Object.keys(subagentModels).length ? subagentModels : null,
          subagentMcpAllow: config.subagentMcpAllow,
          subagentSkills: config.subagentSkills,
          maxPriorStageTokens,
          estimateText,
          compileKwargs,
          conversationId: config.conversationId,
          terminalManager: this.runtimeServices?.terminalManager,
        }) as unknown as CompiledAgent;
      }

      return buildAuditGraph(model, tools, {
        systemPrompt: config.systemPrompt || "",
        subagentSpecs: AUDIT_SUBAGENTS,
        subagentModels: Object.keys(subagentModels).length ? subagentModels : null,
        subagentMcpAllow: config.subagentMcpAllow,
        subagentSkills: config.subagentSkills,
        maxPriorStageTokens,
        estimateText,
        compileKwargs,
        conversationId: config.conversationId,
        terminalManager: this.runtimeServices?.terminalManager,
      }) as unknown as CompiledAgent;
    }

    if (config.mode === "ruflo") {
      const rufloTools = [
        ...tools,
        buildDelegateTool(model, tools, {
          conversationId: config.conversationId,
          terminalManager: this.runtimeServices?.terminalManager,
        }),
      ];
      const agentKwargs = this.runtimeServices?.createAgentKwargs() ?? {};
      return createAgent({
        model,
        tools: rufloTools,
        systemPrompt: config.systemPrompt || "",
        middleware: buildAgentMiddlewareForModel(model, {
          conversationId: config.conversationId,
          terminalManager: this.runtimeServices?.terminalManager,
        }),
        ...agentKwargs,
      }) as unknown as CompiledAgent;
    }

    const agentKwargs = this.runtimeServices?.createAgentKwargs() ?? {};
    return createAgent({
      model,
      tools,
      systemPrompt: config.systemPrompt || "",
      middleware: buildAgentMiddlewareForModel(model, {
        conversationId: config.conversationId,
        terminalManager: this.runtimeServices?.terminalManager,
      }),
      ...agentKwargs,
    }) as unknown as CompiledAgent;
  }

  private loadSubagentModels(
    providers: Record<string, ModelProviderDTO>,
  ): Record<string, BaseChatModel> {
    const models: Record<string, BaseChatModel> = {};
    for (const [name, provider] of Object.entries(providers)) {
      models[name] = this.modelFactory.initModel(provider, null);
    }
    return models;
  }
}
