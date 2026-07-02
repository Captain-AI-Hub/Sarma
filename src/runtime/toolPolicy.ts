/** Shared tool registry and runtime tool filtering policy. */

import type { StructuredToolInterface } from "@langchain/core/tools";

export interface ToolFilterSkill {
  toolAllowlist: Set<string> | null;
  toolDenylist: Set<string> | null;
}

export const BUILTIN_TOOL_NAMES = [
  "web_search",
  "fetch_url",
  "http_exchange",
  "packet_exchange",
  "rag_search",
] as const;

const BUILTIN_TOOL_NAME_SET = new Set<string>(BUILTIN_TOOL_NAMES);

// Static estimate for tools exposed by deepagents/langchain middleware. Keep
// this in one place so compaction and tool assembly cannot drift separately.
export const MIDDLEWARE_TOOL_COUNT = 13;

export function isBuiltinToolName(name: string): boolean {
  return BUILTIN_TOOL_NAME_SET.has(name);
}

export function isBuiltinTool(tool: StructuredToolInterface): boolean {
  return isBuiltinToolName(tool.name ?? "");
}

export function builtinToolCount(rag: { knowledgeBases: { enabled: boolean; name: string }[] }): number {
  const ragEnabled = rag.knowledgeBases.some((kb) => kb.enabled && kb.name);
  return BUILTIN_TOOL_NAMES.length - (ragEnabled ? 0 : 1);
}

export function runtimeStaticToolCount(rag: { knowledgeBases: { enabled: boolean; name: string }[] }): number {
  return builtinToolCount(rag) + MIDDLEWARE_TOOL_COUNT;
}

export function filterToolsBySkill(
  tools: StructuredToolInterface[],
  skill: ToolFilterSkill | null | undefined,
): StructuredToolInterface[] {
  if (!skill) return [...tools];
  let result = [...tools];
  if (skill.toolAllowlist !== null) {
    result = result.filter((tool) => skill.toolAllowlist!.has(tool.name ?? ""));
  }
  if (skill.toolDenylist !== null) {
    result = result.filter((tool) => !skill.toolDenylist!.has(tool.name ?? ""));
  }
  return result;
}

export function toolNameMatchesServer(toolName: string, serverName: string): boolean {
  return (
    toolName === serverName ||
    toolName.startsWith(`${serverName}_`) ||
    toolName.startsWith(`${serverName}__`) ||
    toolName.startsWith(`${serverName}.`) ||
    toolName.startsWith(`${serverName}:`)
  );
}

export function filterToolsByMcpServers(
  tools: StructuredToolInterface[],
  allowedServers: string[] | null | undefined,
): StructuredToolInterface[] {
  if (allowedServers === null || allowedServers === undefined) {
    return [...tools];
  }
  if (allowedServers.length === 0) {
    return tools.filter(isBuiltinTool);
  }
  return tools.filter((tool) => {
    const name = tool.name ?? "";
    return isBuiltinToolName(name) || allowedServers.some((server) => toolNameMatchesServer(name, server));
  });
}

function toolNameMatchesPrefix(toolName: string, prefix: string): boolean {
  return (
    toolName.startsWith(prefix) ||
    toolName.includes(`_${prefix}`) ||
    toolName.includes(`__${prefix}`) ||
    toolName.includes(`.${prefix}`) ||
    toolName.includes(`:${prefix}`)
  );
}

export function filterToolsByPrefixes(
  tools: StructuredToolInterface[],
  prefixes: string[] | undefined,
): StructuredToolInterface[] {
  if (!prefixes || prefixes.length === 0 || tools.length === 0) {
    return [...tools];
  }
  return tools.filter((tool) => isBuiltinTool(tool) || prefixes.some((prefix) => toolNameMatchesPrefix(tool.name ?? "", prefix)));
}
