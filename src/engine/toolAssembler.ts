/** Runtime tool assembly for MCP and built-in Sarma tools. */

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentRunConfig } from "@/engine/models";
import { buildRagSearchTool } from "@/resources/rag";
import { buildHttpExchangeTool, buildPacketExchangeTool } from "@/resources/networkTools";
import { buildFetchUrlTool, buildWebSearchTool } from "@/resources/webTools";
import { filterToolsBySkill } from "@/runtime/toolPolicy";

export class ToolAssembler {
  assemble(mcpTools: StructuredToolInterface[], config: AgentRunConfig): StructuredToolInterface[] {
    const builtin = this.buildBuiltinTools(config);
    // An MCP server exposing a tool with a built-in's name would otherwise
    // produce two tools with the same name — drop the built-in in that case
    // (the MCP tool is the explicitly configured one).
    const mcpNames = new Set(mcpTools.map((tool) => tool.name).filter(Boolean));
    const dedupedBuiltin = builtin.filter((tool) => !tool.name || !mcpNames.has(tool.name));
    return filterToolsBySkill([...mcpTools, ...dedupedBuiltin], config.skill);
  }

  buildBuiltinTools(config: AgentRunConfig): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
      buildWebSearchTool(),
      buildFetchUrlTool(),
      buildHttpExchangeTool(),
      buildPacketExchangeTool(),
    ];
    if (config.rag.knowledgeBases.some((kb) => kb.enabled && kb.name)) {
      tools.push(buildRagSearchTool(config.rag));
    }
    return tools;
  }
}
