/**
 * Analysis graph — 7-stage architecture audit + attack-surface pipeline.
 *
 * Topology (reuses the audit graph's state, node machinery, and structured
 * routers):
 *
 *   survey -> architecture -> surface -> surface_check
 *                                            |  ^-- mapfill (bounded loop,
 *                                            |      gapfill_count <= 3)
 *                                            v
 *                                       threatmap -> review -> review_check
 *                                                              |  ^-- back to
 *                                                              v    surface
 *                                                           report   (feedback_count
 *                                                                    <= 2)
 *                                                              |
 *                                                             END
 *
 * Scope: architecture audit and attack-surface analysis only. Unlike the
 * audit graphs, stages do not validate or exploit vulnerabilities.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { StateGraph, START, END, Command, getWriter } from "@langchain/langgraph";
import {
  AuditState,
  type AuditStateType,
  makeSubagentNode,
  makeRouteAgent,
  prepareAuditInput,
  routeNext,
  routeNextStructured,
} from "@/workflows/auditGraph";
import { ANALYSIS_SUBAGENTS, ANALYSIS_SUBAGENT_ORDER } from "@/workflows/analysisSubagents";
import type { SubagentSpec } from "@/workflows/auditSubagents";
import type { ResolvedSkill } from "@/engine/models";
import type { TokenEstimator } from "@/context/tokenizer";
import type { PersistentTerminalManager } from "@/resources/terminalTools";

/** Bounds for the two analysis loops (surface coverage, review rework). */
export const DEFAULT_MAX_MAPFILL = 3;
export const DEFAULT_MAX_REVIEW = 2;

function writeAnalysisEvent(data: Record<string, unknown>): void {
  let writer: ((chunk: unknown) => void) | undefined;
  try {
    writer = getWriter();
  } catch {
    return;
  }
  writer?.(data);
}

/**
 * After surface: route to mapfill when coverage gaps remain (bounded by
 * gapfill_count), otherwise proceed to threatmap.
 */
function surfaceRouterFromDecision(state: AuditStateType, decision: string): Command {
  const output = (state.stage_outputs ?? {}).surface ?? "";
  const lower = output.toLowerCase();
  const hasGaps = ["gap", "missing", "uncovered", "incomplete", "not covered", "unexplored"].some(
    (k) => lower.includes(k),
  );
  const count = state.gapfill_count ?? 0;

  if ((decision === "mapfill" || (!decision && hasGaps)) && count < DEFAULT_MAX_MAPFILL) {
    const nextCount = count + 1;
    writeAnalysisEvent({
      type: "audit_route",
      from: "surface",
      to: "mapfill",
      loop: "gapfill",
      count: nextCount,
    });
    return new Command({ update: { gapfill_count: nextCount }, goto: "mapfill" });
  }
  writeAnalysisEvent({ type: "audit_route", from: "surface", to: "threatmap" });
  return new Command({ goto: "threatmap" });
}

/**
 * After review: weak or inconsistent analysis routes back to surface for
 * another pass (bounded by feedback_count, which also resets the mapfill
 * budget); otherwise proceed to report.
 */
function reviewRouterFromDecision(state: AuditStateType, decision: string): Command {
  const output = (state.stage_outputs ?? {}).review ?? "";
  const lower = output.toLowerCase();
  const isWeak = ["weak", "insufficient", "inconsistent", "incomplete", "thin", "unsupported"].some(
    (k) => lower.includes(k),
  );
  const count = state.feedback_count ?? 0;

  if ((decision === "surface" || (!decision && isWeak)) && count < DEFAULT_MAX_REVIEW) {
    const nextCount = count + 1;
    writeAnalysisEvent({
      type: "audit_route",
      from: "review",
      to: "surface",
      loop: "feedback",
      count: nextCount,
    });
    return new Command({ update: { feedback_count: nextCount, gapfill_count: 0 }, goto: "surface" });
  }
  writeAnalysisEvent({ type: "audit_route", from: "review", to: "report" });
  return new Command({ goto: "report" });
}

async function routeOrFallback(
  routeAgent: ReturnType<typeof makeRouteAgent> | null,
  stage: string,
  output: string,
  allowed: Set<string>,
): Promise<string> {
  if (routeAgent === null) {
    return routeNext(output, allowed);
  }
  try {
    return await routeNextStructured(routeAgent, stage, output, allowed);
  } catch {
    return routeNext(output, allowed);
  }
}

export interface BuildAnalysisGraphOptions {
  systemPrompt?: string;
  subagentSpecs?: SubagentSpec[];
  subagentModels?: Record<string, BaseChatModel> | null;
  subagentMcpAllow?: Record<string, string[] | null> | null;
  subagentSkills?: Record<string, ResolvedSkill | null> | null;
  structuredRouting?: boolean;
  maxPriorStageTokens?: number;
  estimateText?: TokenEstimator;
  compileKwargs?: Record<string, unknown>;
  conversationId?: string;
  terminalManager?: PersistentTerminalManager | null;
}

/** Build and compile the analysis pipeline StateGraph. */
export function buildAnalysisGraph(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  options: BuildAnalysisGraphOptions = {},
) {
  const specs = options.subagentSpecs ?? ANALYSIS_SUBAGENTS;
  const specMap = new Map(specs.map((s) => [s.name, s]));
  const structuredRouting = options.structuredRouting ?? true;

  const surfaceRouteAgent = structuredRouting ? makeRouteAgent(model, "analysis_surface_router") : null;
  const reviewRouteAgent = structuredRouting ? makeRouteAgent(model, "analysis_review_router") : null;

  const builder = new StateGraph(AuditState);
  // Nodes are registered dynamically; wire through a string-typed view, same
  // as the audit graphs.
  const g = builder as unknown as {
    addNode: (name: string, fn: NodeFn, opts?: { ends?: string[] }) => void;
    addEdge: (from: string, to: string) => void;
    compile: (opts?: Record<string, unknown>) => ReturnType<StateGraph<typeof AuditState.spec>["compile"]>;
  };
  type NodeFn = (state: AuditStateType, config: never) => Promise<Partial<AuditStateType>>;

  for (const name of ANALYSIS_SUBAGENT_ORDER) {
    const spec = specMap.get(name)!;
    const nodeFn = makeSubagentNode(name, spec, model, tools, {
      subagentModels: options.subagentModels,
      allowedMcpServers: (options.subagentMcpAllow ?? {})[name],
      skill: (options.subagentSkills ?? {})[name],
      maxPriorStageTokens: options.maxPriorStageTokens,
      estimateText: options.estimateText,
      conversationId: options.conversationId,
      terminalManager: options.terminalManager,
    }) as unknown as NodeFn;
    g.addNode(name, nodeFn);
  }

  const surfaceCheck: NodeFn = async (state) => {
    writeAnalysisEvent({
      type: "subagent_start",
      name: "surface_check",
      description: "same-model structured router: mapfill | threatmap",
    });
    const output = (state.stage_outputs ?? {}).surface ?? "";
    const decision = await routeOrFallback(
      surfaceRouteAgent,
      "surface",
      output,
      new Set(["mapfill", "threatmap"]),
    );
    const next = surfaceRouterFromDecision(state, decision) as unknown as Partial<AuditStateType>;
    writeAnalysisEvent({ type: "subagent_complete", name: "surface_check" });
    return next;
  };

  const reviewCheck: NodeFn = async (state) => {
    writeAnalysisEvent({
      type: "subagent_start",
      name: "review_check",
      description: "same-model structured router: surface | report",
    });
    const output = (state.stage_outputs ?? {}).review ?? "";
    const decision = await routeOrFallback(
      reviewRouteAgent,
      "review",
      output,
      new Set(["surface", "report"]),
    );
    const next = reviewRouterFromDecision(state, decision) as unknown as Partial<AuditStateType>;
    writeAnalysisEvent({ type: "subagent_complete", name: "review_check" });
    return next;
  };

  g.addNode("surface_check", surfaceCheck, { ends: ["mapfill", "threatmap"] });
  g.addNode("review_check", reviewCheck, { ends: ["surface", "report"] });
  g.addNode("prepare_input", prepareAuditInput);

  // Main line:  survey -> architecture -> surface -> threatmap -> review -> report
  // Mapfill loop: surface_check -> mapfill -> surface (bounded by gapfill_count)
  // Review loop:  review_check -> surface (bounded by feedback_count)
  g.addEdge(START, "prepare_input");
  g.addEdge("prepare_input", "survey");
  g.addEdge("survey", "architecture");
  g.addEdge("architecture", "surface");
  g.addEdge("surface", "surface_check");
  g.addEdge("mapfill", "surface");
  g.addEdge("threatmap", "review");
  g.addEdge("review", "review_check");
  g.addEdge("report", END);

  return g.compile(options.compileKwargs);
}
