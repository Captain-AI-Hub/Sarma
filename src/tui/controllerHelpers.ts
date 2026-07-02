import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { KnowledgeBaseConfig, tryParseContextWindow } from "@/config";
import * as paths from "@/paths";

export function parseContextSize(raw: string): number | null {
  return tryParseContextWindow(raw);
}

export function truncateStatus(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}...` : compact;
}

export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    }).join("");
  }
  return content === null || content === undefined ? "" : String(content);
}

export function safePathName(name: string): string {
  const safe = name.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "knowledge-base";
}

export function expandUserPath(path: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(join(homedir(), path.slice(1)));
  }
  return resolve(path);
}

export function knowledgeBaseChromaPath(kb: KnowledgeBaseConfig): string {
  if (kb.chromaPath.trim()) return expandUserPath(kb.chromaPath);
  return join(paths.ragChromaDir(), safePathName(kb.name));
}

export function upsertKnowledgeBase(
  knowledgeBases: KnowledgeBaseConfig[],
  knowledgeBase: KnowledgeBaseConfig,
): void {
  const index = knowledgeBases.findIndex((kb) => kb.name === knowledgeBase.name);
  if (index >= 0) knowledgeBases[index] = knowledgeBase;
  else knowledgeBases.push(knowledgeBase);
}
