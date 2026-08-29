/**
 * Model capability registry (PLAN §3.1a).
 *
 * The four brains are NOT interchangeable. Every request core builds goes
 * through this record so that, for example, `effort` is never sent to Haiku
 * and mid-conversation system messages are never sent to Sonnet.
 */
export type ModelAlias = "opus" | "fable" | "sonnet" | "haiku";

export type ThinkingMode = "adaptive" | "always" | "budget";

export interface ModelCapabilities {
  alias: ModelAlias;
  id: string;
  label: string;
  /** What the user says to select it. Lower-case, matched as whole words. */
  spokenNames: string[];
  supportsEffort: boolean;
  supportsMidConvSystem: boolean;
  supportsFallbacks: boolean;
  webSearchToolType: "web_search_20260209" | "web_search_20250305";
  contextWindow: number;
  maxOutput: number;
  thinking: ThinkingMode;
  /** Rough $/1M tokens, for the cost meter only. */
  inputPerM: number;
  outputPerM: number;
}

export const MODELS: Record<ModelAlias, ModelCapabilities> = {
  opus: {
    alias: "opus",
    id: "claude-opus-5",
    label: "Claude Opus 5",
    spokenNames: ["opus"],
    supportsEffort: true,
    supportsMidConvSystem: true,
    supportsFallbacks: true,
    webSearchToolType: "web_search_20260209",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    thinking: "adaptive",
    inputPerM: 5,
    outputPerM: 25,
  },
  fable: {
    alias: "fable",
    id: "claude-fable-5",
    label: "Claude Fable 5",
    spokenNames: ["fable"],
    supportsEffort: true,
    supportsMidConvSystem: true,
    supportsFallbacks: true,
    webSearchToolType: "web_search_20260209",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    thinking: "always",
    inputPerM: 10,
    outputPerM: 50,
  },
  sonnet: {
    alias: "sonnet",
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    spokenNames: ["sonnet", "sonet"],
    supportsEffort: true,
    supportsMidConvSystem: false,
    supportsFallbacks: false,
    webSearchToolType: "web_search_20260209",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    thinking: "adaptive",
    inputPerM: 2,
    outputPerM: 10,
  },
  haiku: {
    alias: "haiku",
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    spokenNames: ["haiku", "hiku"],
    supportsEffort: false,
    supportsMidConvSystem: false,
    supportsFallbacks: false,
    webSearchToolType: "web_search_20250305",
    contextWindow: 200_000,
    maxOutput: 64_000,
    thinking: "budget",
    inputPerM: 1,
    outputPerM: 5,
  },
};

export const MODEL_ALIASES = Object.keys(MODELS) as ModelAlias[];

export function isModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as string[]).includes(value);
}

/** Find a model alias mentioned in free text ("switch to sonnet please"). */
export function findSpokenModel(text: string): ModelAlias | undefined {
  const words = text.toLowerCase().split(/[^a-z0-9.]+/);
  for (const alias of MODEL_ALIASES) {
    const m = MODELS[alias];
    if (m.spokenNames.some((n) => words.includes(n))) return alias;
  }
  return undefined;
}
