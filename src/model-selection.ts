export interface ModelSelection {
  requestedProvider: string;
  piProvider: string;
  modelId: string;
  envVar?: string;
  defaulted: boolean;
}

export const curatedProviders = [
  { id: "deepseek", piProvider: "deepseek", defaultModel: "deepseek-flash", envVar: "DEEPSEEK_API_KEY", description: "DeepSeek 官方 API" },
  { id: "kimi", piProvider: "moonshotai-cn", defaultModel: "kimi-k3", envVar: "MOONSHOT_API_KEY", description: "Kimi 通用 API，中国站" },
  { id: "kimi-global", piProvider: "moonshotai", defaultModel: "kimi-k3", envVar: "MOONSHOT_API_KEY", description: "Kimi 通用 API，国际站" },
] as const;

export function selectModel(provider: string | undefined, modelId: string | undefined): ModelSelection {
  if (!provider) throw new Error("--provider is required");
  const curated = curatedProviders.find(item => item.id === provider);
  if (curated) return {
    requestedProvider: provider,
    piProvider: curated.piProvider,
    modelId: modelId ?? curated.defaultModel,
    envVar: curated.envVar,
    defaulted: !modelId,
  };
  if (!modelId) throw new Error(`Provider ${provider} has no VibeGuard default model; add --model ID. Run 'providers' for curated defaults.`);
  return { requestedProvider: provider, piProvider: provider, modelId, defaulted: false };
}
