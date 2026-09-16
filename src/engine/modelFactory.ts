/** Language model construction for Sarma runtimes. */

import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ProviderNotConfiguredError } from "@/engine/errors";
import type { ResolvedSkill } from "@/engine/models";
import type { ModelProviderDTO } from "@/engine/dto";

interface ModelBuildParams {
  modelName: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  topP: number;
}

/**
 * Preserve reasoning_content for OpenAI-compatible thinking models
 * (DeepSeek-R1 etc.).
 *
 * The Python implementation subclasses ChatOpenAI and patches three private
 * hooks. In LangChain.js, recent `@langchain/openai` already surfaces
 * `reasoning_content` into `additional_kwargs`/`response_metadata` on both
 * full results and stream chunks for OpenAI-compatible endpoints, and the
 * outgoing re-injection of prior reasoning is handled at the message layer
 * (`ConversationMessage.toLangchainMessage` stores it in `additional_kwargs`).
 * We therefore construct a stock ChatOpenAI here and rely on those layers.
 */
function buildOpenAiModel(params: ModelBuildParams): BaseChatModel {
  const config: Record<string, unknown> = {};
  if (params.baseUrl) config.baseURL = params.baseUrl;
  return new ChatOpenAI({
    model: params.modelName,
    temperature: params.temperature,
    topP: params.topP,
    apiKey: resolveApiKey(params, "not-needed"),
    ...(Object.keys(config).length ? { configuration: config } : {}),
  });
}

function buildOpenAiResponsesModel(params: ModelBuildParams): BaseChatModel {
  const config: Record<string, unknown> = {};
  if (params.baseUrl) config.baseURL = params.baseUrl;
  return new ChatOpenAI({
    model: params.modelName,
    temperature: params.temperature,
    topP: params.topP,
    useResponsesApi: true,
    apiKey: resolveApiKey(params, "not-needed"),
    ...(Object.keys(config).length ? { configuration: config } : {}),
  });
}

function buildAnthropicModel(params: ModelBuildParams): BaseChatModel {
  return new ChatAnthropic({
    model: params.modelName,
    temperature: params.temperature,
    topP: params.topP,
    apiKey: resolveApiKey(params, "not-needed"),
    ...(params.baseUrl ? { anthropicApiUrl: params.baseUrl } : {}),
  });
}

/**
 * The openai/anthropic SDK clients refuse to construct without an apiKey even
 * when a custom baseURL points at a local endpoint (Ollama/vLLM/llama.cpp)
 * that ignores auth. Pass a placeholder in that case; omit the key entirely
 * only when neither is configured so the SDK's own env lookup still applies.
 */
function resolveApiKey(params: ModelBuildParams, placeholder: string): string | undefined {
  if (params.apiKey) return params.apiKey;
  if (params.baseUrl) return placeholder;
  return undefined;
}

const MODEL_BUILDERS: Record<string, (p: ModelBuildParams) => BaseChatModel> = {
  openai_responses: buildOpenAiResponsesModel,
  openai_compatible: buildOpenAiModel,
  anthropic: buildAnthropicModel,
};

/** Build provider-backed LangChain chat models. */
export class ModelFactory {
  initModel(provider: ModelProviderDTO, skill: ResolvedSkill | null = null): BaseChatModel {
    const apiMode = provider.apiMode;
    const builder = MODEL_BUILDERS[apiMode];
    if (builder === undefined) {
      throw new ProviderNotConfiguredError(`Unsupported api_mode: '${apiMode}'`);
    }

    const modelName =
      skill && skill.preferredModelName ? skill.preferredModelName : provider.modelName;

    let temperature = provider.temperature;
    if (skill && skill.temperatureOverride !== null && skill.temperatureOverride !== undefined) {
      temperature = skill.temperatureOverride;
    }

    return builder({
      modelName,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      temperature,
      topP: provider.topP,
    });
  }
}
