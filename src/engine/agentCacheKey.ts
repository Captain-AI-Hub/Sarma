/** Deterministic cache keys for compiled agents. */

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ModelProviderDTO } from "@/engine/dto";
import type { AgentRunConfig, ResolvedSkill } from "@/engine/models";

function providerKey(provider: ModelProviderDTO): Record<string, unknown> {
  return {
    name: provider.name,
    model_name: provider.modelName,
    api_mode: provider.apiMode,
    api_key: provider.apiKey,
    base_url: provider.baseUrl,
    temperature: provider.temperature,
    top_p: provider.topP,
  };
}

function skillKey(skill: ResolvedSkill | null): Record<string, unknown> | null {
  if (skill === null) return null;
  return {
    id: skill.id,
    name: skill.name,
    system_prompt_suffix: skill.systemPromptSuffix,
    tool_allowlist: skill.toolAllowlist === null ? null : [...skill.toolAllowlist].sort(),
    tool_denylist: skill.toolDenylist === null ? null : [...skill.toolDenylist].sort(),
    preferred_model_name: skill.preferredModelName,
    temperature_override: skill.temperatureOverride,
  };
}

function ragKey(rag: AgentRunConfig["rag"]): Record<string, unknown> {
  return {
    embedding_backend: rag.embeddingBackend,
    embedding_model: rag.embeddingModel,
    embedding_api_base: rag.embeddingApiBase,
    embedding_api_key: rag.embeddingApiKey,
    embedding_local_path: rag.embeddingLocalPath,
    chunk_size: rag.chunkSize,
    chunk_overlap: rag.chunkOverlap,
    knowledge_bases: rag.knowledgeBases.map((kb) => ({
      name: kb.name,
      backend: kb.backend,
      docs_path: kb.docsPath,
      chroma_path: kb.chromaPath,
      chroma_url: kb.chromaUrl,
      collection_name: kb.collectionName,
      tenant: kb.tenant,
      database: kb.database,
      headers: kb.headers,
      enabled: kb.enabled,
    })),
  };
}

export function agentCacheKey(
  config: AgentRunConfig,
  serverConfigs: Record<string, Record<string, unknown>>,
  tools: StructuredToolInterface[],
): string {
  const sortedEntries = <T>(obj: Record<string, T>): [string, T][] =>
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));

  const data = {
    mode: config.mode,
    conversation_id: config.conversationId,
    provider: providerKey(config.provider),
    skill: skillKey(config.skill),
    servers: serverConfigs,
    tools: tools.map((tool) => tool.name ?? String(tool)),
    system_prompt: config.systemPrompt || "",
    subagent_providers: Object.fromEntries(
      sortedEntries(config.subagentProviders).map(([name, provider]) => [name, providerKey(provider)]),
    ),
    subagent_mcp_allow: Object.fromEntries(
      sortedEntries(config.subagentMcpAllow).map(([name, allow]) => [
        name,
        allow === null ? null : [...allow].sort(),
      ]),
    ),
    subagent_skills: Object.fromEntries(
      sortedEntries(config.subagentSkills).map(([name, skill]) => [name, skillKey(skill)]),
    ),
    rag: ragKey(config.rag),
  };
  return stableStringify(data);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
