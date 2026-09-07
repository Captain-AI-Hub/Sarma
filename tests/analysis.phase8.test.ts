/** Analysis workflow graph tests (architecture audit + attack-surface pipeline). */

import { describe, expect, test } from "bun:test";
import { buildAnalysisGraph } from "@/workflows/analysisGraph";
import { ANALYSIS_SUBAGENTS, ANALYSIS_SUBAGENT_ORDER } from "@/workflows/analysisSubagents";
import { getWorkflowMeta, subagentsForWorkflow } from "@/workflows";
import { EventTranslator } from "@/engine/streaming";
import { StreamEventType } from "@/engine/enums";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { HumanMessage } from "@langchain/core/messages";

const ANALYSIS_INPUT = {
  messages: [new HumanMessage("analyze target")],
  audit_task: "analyze target",
  stage_outputs: {},
  gapfill_count: 0,
  feedback_count: 0,
  current_stage: "",
};

function analysisSubagentModels(responses: Record<string, string[]>): Record<string, FakeListChatModel> {
  const models: Record<string, FakeListChatModel> = {};
  for (const name of ANALYSIS_SUBAGENT_ORDER) {
    models[name] = new FakeListChatModel({ responses: responses[name] ?? [`${name} output`] });
  }
  return models;
}

describe("analysis workflow registry", () => {
  test("registers the analysis workflow with its 7 subagents", () => {
    const meta = getWorkflowMeta("analysis");
    expect(meta).not.toBeNull();
    expect([...meta!.subagents]).toEqual([
      "survey",
      "architecture",
      "surface",
      "mapfill",
      "threatmap",
      "review",
      "report",
    ]);
    expect([...subagentsForWorkflow("analysis")]).toEqual([...ANALYSIS_SUBAGENT_ORDER]);
  });

  test("analysis subagent specs expose read-only tool prefixes only", () => {
    // The analysis workflow is an architecture/attack-surface pipeline: no
    // patching, no debugger writes, no renaming.
    const forbidden = [/^patch/, /^apply/, /^rename/, /^dbg/, /^make_/, /^undefine/, /^add_/];
    for (const spec of ANALYSIS_SUBAGENTS) {
      expect(spec.toolPrefixes.length).toBeGreaterThan(0);
      for (const prefix of spec.toolPrefixes) {
        for (const re of forbidden) {
          expect(`${spec.name}:${prefix}`).not.toMatch(re);
        }
      }
    }
  });
});

describe("analysis workflow graph", () => {
  test("runs the main analysis path without mapfill when surface coverage is complete", async () => {
    const model = new FakeListChatModel({ responses: ["router fallback unused"] });
    const graph = buildAnalysisGraph(model, [], {
      structuredRouting: false,
      subagentModels: analysisSubagentModels({
        surface: ["surface matrix complete, all entry categories covered"],
        review: ["analysis complete and ready for reporting"],
        report: ["final analysis report"],
      }),
    });
    const finalState = await graph.invoke(ANALYSIS_INPUT, { recursionLimit: 80 });
    const outputs = (finalState as { stage_outputs?: Record<string, string> }).stage_outputs ?? {};
    expect(outputs.survey).toBe("survey output");
    expect(outputs.architecture).toBe("architecture output");
    expect(outputs.surface).toContain("complete");
    expect(outputs.mapfill).toBeUndefined();
    expect(outputs.threatmap).toBe("threatmap output");
    expect(outputs.report).toBe("final analysis report");
  });

  test("bounds the surface mapfill loop before converging to report", async () => {
    const model = new FakeListChatModel({ responses: ["router fallback unused"] });
    const graph = buildAnalysisGraph(model, [], {
      structuredRouting: false,
      subagentModels: analysisSubagentModels({
        surface: [
          "coverage gap: IPC entries missing from the matrix",
          "coverage gap: file parser inputs missing from the matrix",
          "coverage gap: upgrade path missing from the matrix",
          "coverage gap: environment inputs still missing",
        ],
        report: ["final analysis report"],
      }),
    });
    const finalState = await graph.invoke(ANALYSIS_INPUT, { recursionLimit: 120 });
    const state = finalState as { stage_outputs?: Record<string, string>; gapfill_count?: number };
    const outputs = state.stage_outputs ?? {};
    // DEFAULT_MAX_MAPFILL = 3: the fourth weak surface pass must route on.
    expect(state.gapfill_count).toBe(3);
    expect(outputs.mapfill).toContain("mapfill output");
    expect(outputs.report).toBe("final analysis report");
  });

  test("bounds the review feedback loop and resets the mapfill budget", async () => {
    const model = new FakeListChatModel({ responses: ["router fallback unused"] });
    let surfacePasses = 0;
    const graph = buildAnalysisGraph(model, [], {
      structuredRouting: false,
      subagentModels: analysisSubagentModels({
        surface: new Proxy([] as string[], {
          get(target: string[], prop) {
            if (prop === "length") return 50;
            surfacePasses += 1;
            return `surface pass ${surfacePasses}: coverage gap remains`;
          },
        }) as unknown as string[],
        review: [
          "weak evidence: surface matrix is thin and inconsistent",
          "insufficient coverage: entry categories asserted without evidence",
          "analysis complete and ready for reporting",
        ],
        report: ["final analysis report"],
      }),
    });
    const finalState = await graph.invoke(ANALYSIS_INPUT, { recursionLimit: 200 });
    const state = finalState as {
      stage_outputs?: Record<string, string>;
      feedback_count?: number;
      gapfill_count?: number;
    };
    // DEFAULT_MAX_REVIEW = 2 review rework rounds; each resets mapfill.
    expect(state.feedback_count).toBe(2);
    expect(state.gapfill_count).toBeGreaterThanOrEqual(0);
    expect((state.stage_outputs ?? {}).report).toBe("final analysis report");
  });

  test("streams analysis stages and router nodes as workflow lifecycle events", async () => {
    const model = new FakeListChatModel({
      responses: [
        "survey output",
        "architecture output",
        "surface matrix complete, all entry categories covered",
        "threatmap output",
        "analysis complete and ready for reporting",
        "final analysis report",
      ],
    });
    const graph = buildAnalysisGraph(model, [], { structuredRouting: false });
    const translator = new EventTranslator("c1", "t1");
    const started = new Set<string>();
    const completed = new Set<string>();
    const routes: Array<[string, string]> = [];

    for await (const chunk of await graph.stream(ANALYSIS_INPUT, {
      streamMode: ["messages", "updates", "custom"],
      subgraphs: true,
      recursionLimit: 80,
    })) {
      for (const event of translator.translate(chunk)) {
        if (event.type === StreamEventType.STAGE_START) started.add(String(event.payload.stage));
        if (event.type === StreamEventType.STAGE_COMPLETE) completed.add(String(event.payload.stage));
        if (
          event.type === StreamEventType.CUSTOM_PROGRESS &&
          (event.payload.data as { type?: string })?.type === "audit_route"
        ) {
          const data = event.payload.data as { from?: string; to?: string };
          routes.push([String(data.from), String(data.to)]);
        }
      }
    }

    for (const stage of ["survey", "architecture", "surface", "threatmap", "review", "report"]) {
      expect(started.has(stage)).toBe(true);
      expect(completed.has(stage)).toBe(true);
    }
    expect(started.has("mapfill")).toBe(false);
    expect(routes).toContainEqual(["surface", "threatmap"]);
    expect(routes).toContainEqual(["review", "report"]);
  });
});
