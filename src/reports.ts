/**
 * Per-run markdown report writer.
 *
 * Every successfully completed turn writes one markdown file under
 * `./.sarma/reports/`: metadata, the user task, each pipeline stage's output
 * (audit/analysis workflows), or the assistant answer (ruflo). The final
 * report stage's output is the user-facing result and closes the file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as paths from "@/paths";

export interface RunReportInput {
  workflow: string;
  conversationId: string;
  turnId: string;
  modelName: string;
  task: string;
  /** Ordered stage name → output (graph workflows); empty for ruflo. */
  stageOutputs: Record<string, string>;
  /** Final user-facing content (report stage output, or assistant answer). */
  finalContent: string;
  timestamp?: Date;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function heading(name: string): string {
  return `## ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** Render the run report as markdown (pure — no filesystem access). */
export function renderRunMarkdown(input: RunReportInput): string {
  const timestamp = input.timestamp ?? new Date();
  const lines: string[] = [
    `# Sarma ${input.workflow} report`,
    "",
    `- Generated: ${timestamp.toISOString()}`,
    `- Workflow: ${input.workflow}`,
    `- Model: ${input.modelName || "(unset)"}`,
    `- Conversation: ${input.conversationId}`,
    `- Turn: ${input.turnId}`,
    "",
    heading("Task"),
    "",
    input.task.trim() || "(empty task)",
    "",
  ];

  const stages = Object.entries(input.stageOutputs).filter(([, v]) => v && v.trim());
  if (stages.length > 0) {
    for (const [name, output] of stages) {
      lines.push(heading(name), "", output.trim(), "");
    }
  }

  // For graph workflows the report stage is the last stage output above; for
  // single-agent workflows (ruflo) the final content is the only answer.
  const hasReportStage = "report" in input.stageOutputs;
  if (!hasReportStage && input.finalContent.trim()) {
    lines.push(heading("Result"), "", input.finalContent.trim(), "");
  }

  return lines.join("\n");
}

function safeFileToken(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "run";
}

/**
 * Write the run report and return its path. Timestamp + turn id keep the
 * filename unique even for rapid successive turns.
 */
export function writeRunReport(input: RunReportInput): string {
  const timestamp = input.timestamp ?? new Date();
  const dir = paths.reportsDir();
  const fileName = `${formatTimestamp(timestamp)}-${safeFileToken(input.workflow)}-${input.turnId}.md`;
  const target = join(dir, fileName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, renderRunMarkdown(input), { encoding: "utf-8" });
  return target;
}
