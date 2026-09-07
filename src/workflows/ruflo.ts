/**
 * Ruflo orchestration helpers.
 *
 * Ruflo is the default conversational workflow. It keeps a primary ReAct agent,
 * but gives it a controlled delegation tool for spawning focused subagents.
 * Each subagent returns a compact result template instead of a full reasoning
 * trace.
 *
 * The Ruflo system prompt lives in `engine/prompts.ts` (RUFLO_SYSTEM_PROMPT,
 * applied by the runtime resolver); this module owns delegation only.
 */

import { z } from "zod";
import { createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildAgentMiddlewareForModel } from "@/runtime/middleware";
import type { PersistentTerminalManager } from "@/resources/terminalTools";

export const SUBAGENT_RESULT_TEMPLATE = `Return only this result template. Do not include hidden chain-of-thought,
private reasoning, or a full transcript.

Result:
- Outcome:
- Key evidence:
- Files / functions / addresses / commands:
- Risks or confidence:
- Recommended next action:
`;

/** Create the Ruflo delegation tool. */
export function buildDelegateTool(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  options: { conversationId?: string; terminalManager?: PersistentTerminalManager | null } = {},
): StructuredToolInterface {
  const delegateTask = tool(
    async (
      {
        subagent_name,
        task,
        expected_output = "",
      }: {
        subagent_name: string;
        task: string;
        expected_output?: string;
      },
      config?: { signal?: AbortSignal },
    ): Promise<string> => {
      const label = (subagent_name || "subagent").trim();
      const expected =
        expected_output.trim() || "Return useful findings for the primary agent.";
      const prompt = `You are a focused Ruflo subagent named ${label}.

Task:
${task}

Expected output:
${expected}

${SUBAGENT_RESULT_TEMPLATE}
`;
      const subagent = createAgent({
        model,
        tools,
        systemPrompt: prompt,
        middleware: buildAgentMiddlewareForModel(model, {
          conversationId: options.conversationId,
          terminalManager: options.terminalManager,
        }),
      });
      let result: { messages?: { content?: unknown }[] };
      try {
        result = (await subagent.invoke(
          { messages: [new HumanMessage(task)] },
          // Propagate the outer run's abort signal so cancelling the primary
          // agent also cancels the in-flight delegated subagent.
          { recursionLimit: 100, signal: config?.signal },
        )) as { messages?: { content?: unknown }[] };
      } catch (exc) {
        throw new Error(`delegate_task subagent "${label}" failed: ${formatErrorChain(exc)}`);
      }
      const messages = result.messages ?? [];
      if (messages.length === 0) {
        return "Result:\n- Outcome: No subagent result returned.";
      }
      return stringifyContent(messages[messages.length - 1]!.content);
    },
    {
      name: "delegate_task",
      description:
        "Run a focused subagent and return a compact result.\n\n" +
        "Args:\n" +
        "  subagent_name: Short label for the subagent, e.g. recon, verifier, " +
        "code-reviewer, reverse-engineer.\n" +
        "  task: Focused task for the subagent.\n" +
        "  expected_output: Optional output requirements for the result.",
      schema: z.object({
        subagent_name: z.string(),
        task: z.string(),
        expected_output: z.string().default(""),
      }),
    },
  );

  return delegateTask as unknown as StructuredToolInterface;
}

function formatErrorChain(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message}`];
  let cause = error.cause;
  while (cause) {
    if (cause instanceof Error) {
      parts.push(`${cause.name}: ${cause.message}`);
      cause = cause.cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return parts.join(" <- ");
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (obj.type === "text") parts.push(String(obj.text ?? ""));
        else if ("content" in obj) parts.push(String(obj.content));
      }
    }
    return parts.filter((p) => p).join("\n").trim();
  }
  return String(content ?? "");
}
