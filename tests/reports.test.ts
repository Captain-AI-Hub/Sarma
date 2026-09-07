/** Run-report markdown writer tests. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRunMarkdown, writeRunReport, type RunReportInput } from "@/reports";

const baseInput: RunReportInput = {
  workflow: "analysis",
  conversationId: "conv-1",
  turnId: "turn-1",
  modelName: "test-model",
  task: "Analyze the firmware's attack surface",
  stageOutputs: {
    survey: "inventory of 3 modules",
    architecture: "two layers, one trust boundary",
    report: "final analysis report",
  },
  finalContent: "final analysis report",
  timestamp: new Date("2026-09-07T12:00:00Z"),
};

describe("renderRunMarkdown", () => {
  test("renders metadata, task, and every stage output", () => {
    const md = renderRunMarkdown(baseInput);
    expect(md).toContain("# Sarma analysis report");
    expect(md).toContain("- Workflow: analysis");
    expect(md).toContain("- Model: test-model");
    expect(md).toContain("- Conversation: conv-1");
    expect(md).toContain("- Turn: turn-1");
    expect(md).toContain("## Task");
    expect(md).toContain("Analyze the firmware's attack surface");
    expect(md).toContain("## Survey");
    expect(md).toContain("inventory of 3 modules");
    expect(md).toContain("## Architecture");
    expect(md).toContain("two layers, one trust boundary");
    expect(md).toContain("## Report");
    expect(md).toContain("final analysis report");
  });

  test("does not duplicate the report stage as a Result section", () => {
    const md = renderRunMarkdown(baseInput);
    expect(md).not.toContain("## Result");
  });

  test("renders a Result section for single-agent workflows", () => {
    const md = renderRunMarkdown({
      ...baseInput,
      workflow: "ruflo",
      stageOutputs: {},
      finalContent: "the assistant answer",
    });
    expect(md).toContain("# Sarma ruflo report");
    expect(md).toContain("## Result");
    expect(md).toContain("the assistant answer");
    expect(md).not.toContain("## Survey");
  });

  test("skips empty stage outputs", () => {
    const md = renderRunMarkdown({
      ...baseInput,
      stageOutputs: { survey: "  ", report: "final analysis report" },
    });
    expect(md).not.toContain("## Survey");
    expect(md).toContain("## Report");
  });
});

describe("writeRunReport", () => {
  const sandbox = join(tmpdir(), `sarma-reports-test-${process.pid}-${Date.now()}`);
  const previousCwd = process.cwd();

  test("writes a uniquely named markdown file into the reports dir", () => {
    try {
      mkdirSync(sandbox, { recursive: true });
      process.chdir(sandbox);
      const path = writeRunReport(baseInput);
      expect(path).toBe(join(sandbox, ".sarma", "reports", "20260907-120000-analysis-turn-1.md"));
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toContain("final analysis report");

      // Same timestamp but a different turn id must not collide.
      const second = writeRunReport({ ...baseInput, turnId: "turn-2" });
      expect(second).not.toBe(path);
      expect(existsSync(second)).toBe(true);
    } finally {
      process.chdir(previousCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
