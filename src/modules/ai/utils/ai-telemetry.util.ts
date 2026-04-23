import { Logger } from '@nestjs/common';

export interface AiOperationContext {
  feature: string;
  provider?: string;
  endpoint: string;
  model?: string;
  size?: string;
  quality?: string;
  mode?: string;
  inputFidelity?: string;
}

interface AiUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface AiCostMetrics extends AiUsageMetrics {
  costEstimated: boolean;
  estimatedCostUsd?: number;
  costSource?: string;
  billableUnits?: number;
}

export async function withAiLogging<T>(
  logger: Logger,
  context: AiOperationContext,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const base = sanitizeContext(context);

  logger.log(`AI operation started ${JSON.stringify(base)}`);

  try {
    const result = await operation();
    logger.log(
      `AI operation finished ${JSON.stringify({
        ...base,
        durationMs: Date.now() - startedAt,
        status: 'success',
        ...buildCostMetrics(base, result),
      })}`,
    );
    return result;
  } catch (error) {
    logger.error(
      `AI operation failed ${JSON.stringify({
        ...base,
        durationMs: Date.now() - startedAt,
        status: 'error',
        error: (error as Error).message,
      })}`,
    );
    throw error;
  }
}

function sanitizeContext(context: AiOperationContext): AiOperationContext {
  return {
    feature: context.feature,
    provider: context.provider ?? 'openai',
    endpoint: context.endpoint,
    model: context.model,
    size: context.size,
    quality: context.quality,
    mode: context.mode,
    inputFidelity: context.inputFidelity,
  };
}

function buildCostMetrics(context: AiOperationContext, result: unknown): AiCostMetrics {
  const usage = extractUsageMetrics(result);

  if (context.endpoint.startsWith('images.')) {
    const imageCost = estimateImageCost(context);
    return {
      ...usage,
      billableUnits: 1,
      costEstimated: imageCost.costEstimated,
      estimatedCostUsd: imageCost.estimatedCostUsd,
      costSource: imageCost.costSource,
    };
  }

  const tokenCost = estimateTokenCost(context, usage);
  return {
    ...usage,
    costEstimated: tokenCost.costEstimated,
    estimatedCostUsd: tokenCost.estimatedCostUsd,
    costSource: tokenCost.costSource,
  };
}

function extractUsageMetrics(result: unknown): AiUsageMetrics {
  const usage = (result as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') {
    return {};
  }

  const inputTokens =
    numberFromUnknown(usage.prompt_tokens) ?? numberFromUnknown(usage.input_tokens);
  const outputTokens =
    numberFromUnknown(usage.completion_tokens) ?? numberFromUnknown(usage.output_tokens);
  const totalTokens =
    numberFromUnknown(usage.total_tokens) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function estimateTokenCost(
  context: AiOperationContext,
  usage: AiUsageMetrics,
): Pick<AiCostMetrics, 'costEstimated' | 'estimatedCostUsd' | 'costSource'> {
  if (!usage.inputTokens && !usage.outputTokens) {
    return { costEstimated: false };
  }

  const modelKey = context.model ? sanitizeEnvKey(context.model) : undefined;
  const inputRate = readEnvNumber(
    modelKey ? `OPENAI_COST_${modelKey}_INPUT_1M_USD` : undefined,
    'OPENAI_COST_TEXT_INPUT_1M_USD',
  );
  const outputRate = readEnvNumber(
    modelKey ? `OPENAI_COST_${modelKey}_OUTPUT_1M_USD` : undefined,
    'OPENAI_COST_TEXT_OUTPUT_1M_USD',
  );

  if (!inputRate && !outputRate) {
    return { costEstimated: false };
  }

  const inputCost = ((usage.inputTokens ?? 0) / 1_000_000) * (inputRate?.value ?? 0);
  const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * (outputRate?.value ?? 0);

  return {
    costEstimated: true,
    estimatedCostUsd: roundCost(inputCost + outputCost),
    costSource: [inputRate?.source, outputRate?.source].filter(Boolean).join(','),
  };
}

function estimateImageCost(
  context: AiOperationContext,
): Pick<AiCostMetrics, 'costEstimated' | 'estimatedCostUsd' | 'costSource'> {
  const modelKey = context.model ? sanitizeEnvKey(context.model) : undefined;
  const modeKey = context.mode ? sanitizeEnvKey(context.mode) : undefined;
  const qualityKey = context.quality ? sanitizeEnvKey(context.quality) : undefined;
  const sizeKey = context.size ? sanitizeEnvKey(context.size) : undefined;

  const imageCost = readEnvNumber(
    modelKey && modeKey && qualityKey && sizeKey
      ? `OPENAI_COST_IMAGE_${modelKey}_${modeKey}_${qualityKey}_${sizeKey}_USD`
      : undefined,
    modelKey && modeKey && qualityKey
      ? `OPENAI_COST_IMAGE_${modelKey}_${modeKey}_${qualityKey}_USD`
      : undefined,
    modelKey && modeKey ? `OPENAI_COST_IMAGE_${modelKey}_${modeKey}_USD` : undefined,
    modeKey ? `OPENAI_COST_IMAGE_${modeKey}_USD` : undefined,
    'OPENAI_COST_IMAGE_USD',
  );

  if (!imageCost) {
    return { costEstimated: false };
  }

  return {
    costEstimated: true,
    estimatedCostUsd: roundCost(imageCost.value),
    costSource: imageCost.source,
  };
}

function readEnvNumber(...keys: Array<string | undefined>) {
  for (const key of keys) {
    if (!key) continue;

    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') continue;

    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) {
      return { value, source: key };
    }
  }

  return undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeEnvKey(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
