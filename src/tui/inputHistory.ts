import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { inputHistoryFile } from "@/paths";

const DEFAULT_LIMIT = 1000;
const MAX_ENTRY_CHARS = 4000;

interface InputHistoryOptions {
  file?: string;
  limit?: number;
}

function pathFrom(options: InputHistoryOptions = {}): string {
  return options.file ?? inputHistoryFile();
}

function limitFrom(options: InputHistoryOptions = {}): number {
  return Math.max(1, options.limit ?? DEFAULT_LIMIT);
}

function normalizeLine(text: string): string {
  // Cap single entries so one giant paste cannot balloon the history file.
  return text.replace(/\r?\n/g, " ").trim().slice(0, MAX_ENTRY_CHARS);
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

export function loadInputHistory(options: InputHistoryOptions = {}): string[] {
  const file = pathFrom(options);
  try {
    const lines = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(-limitFrom(options));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // Unreadable history (permissions, directory, corruption) must never
    // abort TUI boot — degrade to an empty history instead.
    return [];
  }
}

export function appendInputHistory(text: string, options: InputHistoryOptions = {}): string[] {
  const entry = normalizeLine(text);
  if (!entry) return loadInputHistory(options);

  const limit = limitFrom(options);
  const entries = loadInputHistory({ ...options, limit });
  // Re-submitting an older entry moves it to the end (shell-history
  // semantics) rather than duplicating it.
  const withoutEntry = entries.filter((existing) => existing !== entry);
  withoutEntry.push(entry);
  const trimmed = withoutEntry.slice(-limit);

  try {
    atomicWrite(pathFrom(options), `${trimmed.join("\n")}${trimmed.length ? "\n" : ""}`);
  } catch {
    // History persistence is best-effort; losing it must not break submit.
  }
  return trimmed;
}
