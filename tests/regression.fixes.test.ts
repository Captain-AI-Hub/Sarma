/** Regression tests for the comprehensive-fix audit round. */

import { describe, expect, test } from "bun:test";
import { agentCacheKey } from "@/engine/agentCacheKey";
import { makeAgentRunConfig, ResolvedSkill } from "@/engine/models";
import { ModelProviderDTO } from "@/engine/dto";
import { EventTranslator } from "@/engine/streaming";
import { StreamEventType } from "@/engine/enums";
import { buildAnalysisGraph } from "@/workflows/analysisGraph";
import { ANALYSIS_SUBAGENT_ORDER } from "@/workflows/analysisSubagents";
import { RuntimePolicyResolver } from "@/runtime/resolver";
import { loadConfig } from "@/config";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { HumanMessage } from "@langchain/core/messages";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("agentCacheKey pool generation", () => {
  const baseConfig = makeAgentRunConfig({
    conversationId: "c1",
    provider: new ModelProviderDTO({
      id: null,
      name: "p",
      modelName: "m",
      apiMode: "openai_compatible",
      apiKey: "",
      baseUrl: "",
      temperature: 0,
      topP: 1,
      maxContextTokens: 128000,
      enabled: true,
    }),
    userMessage: "hi",
    skill: new ResolvedSkill({ name: "s" }),
  });

  test("keys differ across pool generations with identical tools", () => {
    const keyA = agentCacheKey(baseConfig, {}, [], 1);
    const keyB = agentCacheKey(baseConfig, {}, [], 2);
    expect(keyA).not.toBe(keyB);
  });

  test("keys match for the same generation", () => {
    expect(agentCacheKey(baseConfig, {}, [], 3)).toBe(agentCacheKey(baseConfig, {}, [], 3));
  });
});

describe("EventTranslator subagent_error routing", () => {
  test("emits STAGE_ERROR for known workflow stage failures", () => {
    const translator = new EventTranslator("c1", "t1");
    const events = translator.translate([
      [],
      "custom",
      { type: "subagent_error", name: "survey", error: "model exploded" },
    ]);
    const stageErrors = events.filter((e) => e.type === StreamEventType.STAGE_ERROR);
    expect(stageErrors.length).toBe(1);
    expect(stageErrors[0]!.payload.stage).toBe("survey");
    expect(stageErrors[0]!.payload.error_text).toBe("model exploded");
  });

  test("emits SUBAGENT_ERROR for non-stage subagent failures", () => {
    const translator = new EventTranslator("c1", "t1");
    const events = translator.translate([
      [],
      "custom",
      { type: "subagent_error", name: "custom-worker", error: "boom" },
    ]);
    expect(events.some((e) => e.type === StreamEventType.SUBAGENT_ERROR)).toBe(true);
    expect(events.some((e) => e.type === StreamEventType.STAGE_ERROR)).toBe(false);
  });
});

describe("router keyword word boundaries", () => {
  test("surface output mentioning its own mapfill coverage does not loop", async () => {
    // "gapfill" contains "gap" — the old substring match routed this into the
    // mapfill loop; the word-boundary match must not.
    const model = new FakeListChatModel({ responses: ["router fallback unused"] });
    const graph = buildAnalysisGraph(model, [], {
      structuredRouting: false,
      subagentModels: analysisSubagentModels({
        surface: ["gapfill coverage is complete; the matrix covers every entry category"],
        report: ["final analysis report"],
      }),
    });
    const finalState = (await graph.invoke(ANALYSIS_INPUT, { recursionLimit: 80 })) as {
      stage_outputs?: Record<string, string>;
    };
    expect(finalState.stage_outputs?.mapfill).toBeUndefined();
    expect(finalState.stage_outputs?.report).toBe("final analysis report");
  });

  test("an explicit gap mention still routes to mapfill", async () => {
    const model = new FakeListChatModel({ responses: ["router fallback unused"] });
    const graph = buildAnalysisGraph(model, [], {
      structuredRouting: false,
      subagentModels: analysisSubagentModels({
        surface: ["coverage gap: IPC entries missing from the matrix"],
        report: ["final analysis report"],
      }),
    });
    const finalState = (await graph.invoke(ANALYSIS_INPUT, { recursionLimit: 120 })) as {
      stage_outputs?: Record<string, string>;
    };
    expect(finalState.stage_outputs?.mapfill).toBeDefined();
  });
});

describe("resolver analysis workflow", () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origHome: string | undefined;
  let origCwd: string;

  test("resolve(analysis) wires all 7 subagents", () => {
    tmpHome = mkdtempSync(join(tmpdir(), "sarma-home-"));
    tmpCwd = mkdtempSync(join(tmpdir(), "sarma-cwd-"));
    origHome = process.env.SARMA_HOME;
    origCwd = process.cwd();
    process.env.SARMA_HOME = tmpHome;
    process.chdir(tmpCwd);
    try {
      const plan = new RuntimePolicyResolver(loadConfig()).resolve("analysis");
      const names = Object.keys(plan.subagentProviders).sort();
      expect(names).toEqual(
        ["architecture", "mapfill", "report", "review", "surface", "survey", "threatmap"].sort(),
      );
      expect(plan.systemPrompt).toContain("architecture");
    } finally {
      process.chdir(origCwd);
      if (origHome === undefined) delete process.env.SARMA_HOME;
      else process.env.SARMA_HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
