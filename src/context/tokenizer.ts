import { encodingForModel, getEncoding, type TiktokenEncoding } from "js-tiktoken";
import type { ProviderConfig } from "@/config";
import type { ModelProviderDTO } from "@/engine/dto";

export type TokenEstimator = (text: string) => number;

export function fallbackEstimate(text: string): number {
  return Math.max(0, Math.ceil((text || "").length / 4));
}

// js-tiktoken's getEncoding/encodingForModel construct a fresh Tiktoken (and
// re-parse the rank table) on every call — ~300ms each. Memoize per encoding
// name at module level; encoders are stateless and shared freely.
const encodingCache = new Map<string, ReturnType<typeof getEncoding> | null>();

function cachedEncoding(name: string): ReturnType<typeof getEncoding> | null {
  if (encodingCache.has(name)) return encodingCache.get(name) ?? null;
  let enc: ReturnType<typeof getEncoding> | null = null;
  try {
    enc = getEncoding(name as TiktokenEncoding);
  } catch {
    enc = null;
  }
  encodingCache.set(name, enc);
  return enc;
}

function openAiEncodingFor(modelName: string): ReturnType<typeof getEncoding> | null {
  try {
    const byModel = encodingForModel(modelName as never);
    if (byModel) return byModel;
  } catch {
    // Unknown model id: fall through to the generic encoding below.
  }
  // Heuristic: non-OpenAI (including Anthropic-protocol) models fall back to
  // o200k_base with a safety multiplier rather than a claude-specific table.
  return cachedEncoding("o200k_base");
}

export function createTokenEstimator(provider: ProviderConfig | ModelProviderDTO | null): TokenEstimator {
  const modelName = provider?.modelName || "";
  const apiMode = provider?.apiMode || "openai_compatible";
  const enc = openAiEncodingFor(modelName);
  const safety = apiMode === "anthropic" ? 1.15 : 1.0;
  return (text: string): number => {
    if (!text) return 0;
    if (!enc) return Math.ceil(fallbackEstimate(text) * safety);
    try {
      return Math.ceil(enc.encode(text).length * safety);
    } catch {
      return Math.ceil(fallbackEstimate(text) * safety);
    }
  };
}
