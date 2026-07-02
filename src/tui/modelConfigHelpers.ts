import { ProviderConfig } from "@/config";
import { parseContextSize } from "@/tui/controllerHelpers";

const API_MODES = ["openai_compatible", "openai_responses", "anthropic"];

interface ModelDraftLike {
  name: string;
  modelName: string;
  apiMode: string;
  baseUrl: string;
  apiKey: string;
  maxContextTokens: string;
  enabled: string;
}

export interface ProviderDraftResult {
  provider: ProviderConfig | null;
  error: string | null;
  name: string;
  modelId: string;
  ctx: number;
}

export function providerFromModelDraft(
  modelDraft: ModelDraftLike,
  existingProvider: ProviderConfig | null,
): ProviderDraftResult {
  const name = modelDraft.name.trim() || "default";
  const modelId = modelDraft.modelName.trim();
  if (!modelId) return { provider: null, error: "Model ID is required.", name, modelId, ctx: 0 };
  const ctx = parseContextSize(modelDraft.maxContextTokens);
  if (ctx === null) {
    return {
      provider: null,
      error: "Context size must be a positive number (e.g. 128000, 200K, 1M).",
      name,
      modelId,
      ctx: 0,
    };
  }
  const existing = existingProvider ?? new ProviderConfig({ name });
  return {
    provider: new ProviderConfig({
      name,
      modelName: modelId,
      apiMode: API_MODES.includes(modelDraft.apiMode) ? modelDraft.apiMode : "openai_compatible",
      baseUrl: modelDraft.baseUrl.trim(),
      apiKey: modelDraft.apiKey,
      temperature: existing.temperature,
      topP: existing.topP,
      maxContextTokens: ctx,
      enabled: parseBool(modelDraft.enabled),
    }),
    error: null,
    name,
    modelId,
    ctx,
  };
}

function parseBool(value: string): boolean {
  return ["1", "true", "yes", "y", "on", "enabled"].includes(value.trim().toLowerCase());
}
