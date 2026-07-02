/** Runtime tool assembly for MCP and built-in Sarma tools. */

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentRunConfig } from "@/engine/models";
import { buildRagSearchTool } from "@/resources/rag";
import { buildHttpExchangeTool, buildPacketExchangeTool } from "@/resources/networkTools";
import { buildFetchUrlTool, buildWebSearchTool } from "@/resources/webTools";
import { filterToolsBySkill } from "@/runtime/toolPolicy";

export class ToolAssembler {
  assemble(mcpTools: StructuredToolInterface[], config: AgentRunConfig): StructuredToolInterface[] {
    return filterToolsBySkill([...mcpTools, ...this.buildBuiltinTools(config)], config.skill);
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
