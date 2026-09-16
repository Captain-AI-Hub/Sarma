import { tryParseContextWindow } from "@/config";

// RAG path/upsert helpers live in @/resources/rag (canonical); the TUI
// controller imports them from there directly. This module keeps only
// TUI-specific formatting/parsing helpers.

/**
 * Parse a form/TOML boolean field. Unrecognized input falls back to `dflt`:
 * MCP/skill/KB enable toggles default to enabled; model profiles default to
 * disabled (callers pass the domain default explicitly).
 */
export function parseBoolField(value: string, dflt = true): boolean {
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "enabled"].includes(v)) return true;
  if (["0", "false", "no", "n", "off", "disabled"].includes(v)) return false;
  return dflt;
}

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
