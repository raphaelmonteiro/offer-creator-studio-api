import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { OpenAiModelConfig } from '../config/openai-models.config';
import { IMAGE_INTENT_CALL } from '../config/openai-text-calls';
import { IMAGE_INTENT_CLASSIFICATION_SYSTEM_PROMPT } from '../prompts/image-intent.prompts';
import {
  AI_RESPONSE_FORMATS,
  ImageIntentCategory,
  parseImageIntentClassification,
} from '../schemas/ai-response.schemas';
import { createStructuredChatCompletion } from './ai-structured-chat.util';

/**
 * Intenção do pedido sobre a imagem do template (template por imagem e em camadas): uma classificação curta pelo
 * modelo rápido, com o fallback de regra quando o provedor falha ou a confiança é baixa. Estava copiada nos dois
 * serviços (PV-10 da change 42; D-orq-200).
 */
export interface ImageIntentClassification {
  category: ImageIntentCategory;
  confidence: number;
  shouldGenerateImage: boolean;
  shouldEditExistingImage: boolean;
  shouldUseLayerFlow: boolean;
  shouldPreserveExistingImage: boolean;
  reason?: string;
}

export interface ImageIntentContext {
  feature: string;
  userMessage: string;
  hasExistingImage: boolean;
  hasReferenceImages: boolean;
  hasCurrentLayers?: boolean;
}

/** O que o serviço dono da chamada empresta: o cliente (ausente = só o fallback), o log e a configuração de modelo. */
export interface ImageIntentRuntime {
  openai: OpenAI | null;
  logger: Logger;
  models: Pick<OpenAiModelConfig, 'fastTextModel' | 'structuredResponseRetryAttempts'>;
}

/** Abaixo desta confiança vale o fallback de regra, não a classificação do modelo. */
const MIN_CONFIDENCE = 0.55;

export async function classifyImageIntent(
  runtime: ImageIntentRuntime,
  context: ImageIntentContext,
): Promise<ImageIntentClassification> {
  const { openai, logger } = runtime;
  const fallback = getFallbackImageIntent(context);
  if (!openai) return fallback;

  try {
    const parsed = await askImageIntent({ ...runtime, openai }, context);

    if (parsed.confidence < MIN_CONFIDENCE) {
      logImageIntentClassification(logger, context, fallback, 'low-confidence-fallback');
      return fallback;
    }

    const classified = buildImageIntentClassification(
      parsed.category,
      parsed.confidence,
      context,
      parsed.reason,
    );
    logImageIntentClassification(logger, context, classified, 'classified');
    return classified;
  } catch (error) {
    logger.warn(
      `Image intent classification failed ${JSON.stringify({
        feature: context.feature,
        error: (error as Error).message,
      })}`,
    );
    return fallback;
  }
}

/** A chamada estruturada ao modelo rápido (esforço `none`, `temperature: 0` na família nova) e a leitura da resposta. */
function askImageIntent(
  runtime: ImageIntentRuntime & { openai: OpenAI },
  context: ImageIntentContext,
) {
  const { openai, logger, models } = runtime;
  return createStructuredChatCompletion({
    openai,
    logger,
    feature: context.feature,
    spec: { model: models.fastTextModel, ...IMAGE_INTENT_CALL },
    messages: [
      { role: 'system', content: IMAGE_INTENT_CLASSIFICATION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          message: context.userMessage,
          hasExistingImage: context.hasExistingImage,
          hasReferenceImages: context.hasReferenceImages,
          hasCurrentLayers: !!context.hasCurrentLayers,
        }),
      },
    ],
    responseFormat: AI_RESPONSE_FORMATS.imageIntentClassification,
    parse: parseImageIntentClassification,
    emptyResponseMessage: 'Resposta vazia da classificação de intenção',
    retryAttempts: models.structuredResponseRetryAttempts,
  });
}

export function getFallbackImageIntent(context: ImageIntentContext): ImageIntentClassification {
  const category: ImageIntentCategory = context.hasExistingImage
    ? 'targeted_edit'
    : context.hasReferenceImages
      ? 'style_variation'
      : 'new_full_image';

  return buildImageIntentClassification(category, 0, context, 'fallback');
}

type IntentFlags = Pick<
  ImageIntentClassification,
  | 'shouldGenerateImage'
  | 'shouldEditExistingImage'
  | 'shouldUseLayerFlow'
  | 'shouldPreserveExistingImage'
>;

/** Todas as decisões desligadas; cada categoria liga só as suas. */
const NO_FLAGS: IntentFlags = {
  shouldGenerateImage: false,
  shouldEditExistingImage: false,
  shouldUseLayerFlow: false,
  shouldPreserveExistingImage: false,
};

export function buildImageIntentClassification(
  category: ImageIntentCategory,
  confidence: number,
  context: ImageIntentContext,
  reason?: string,
): ImageIntentClassification {
  const canPreserve = context.hasExistingImage || !!context.hasCurrentLayers;
  const hasImageInput = context.hasExistingImage || context.hasReferenceImages;
  const intent = (kind: ImageIntentCategory, flags: Partial<IntentFlags>) => ({
    category: kind,
    confidence,
    ...NO_FLAGS,
    ...flags,
    reason,
  });

  switch (category) {
    case 'text_change':
    case 'layout_change':
      return intent(category, {
        shouldGenerateImage: !canPreserve,
        shouldPreserveExistingImage: canPreserve,
      });
    case 'add_layer_element':
    case 'replace_layer_element':
      return intent(category, {
        shouldGenerateImage: true,
        shouldEditExistingImage: hasImageInput,
        shouldUseLayerFlow: true,
      });
    case 'targeted_edit':
      return intent(category, {
        shouldGenerateImage: !context.hasExistingImage,
        shouldEditExistingImage: context.hasExistingImage,
      });
    case 'style_variation':
      return intent(category, {
        shouldGenerateImage: !hasImageInput,
        shouldEditExistingImage: hasImageInput,
      });
    case 'new_full_image':
    default:
      return intent('new_full_image', { shouldGenerateImage: true });
  }
}

function logImageIntentClassification(
  logger: Logger,
  context: ImageIntentContext,
  intent: ImageIntentClassification,
  status: string,
): void {
  logger.log(
    `Image intent ${JSON.stringify({
      feature: context.feature,
      status,
      category: intent.category,
      confidence: intent.confidence,
      hasExistingImage: context.hasExistingImage,
      hasReferenceImages: context.hasReferenceImages,
      hasCurrentLayers: !!context.hasCurrentLayers,
      shouldGenerateImage: intent.shouldGenerateImage,
      shouldEditExistingImage: intent.shouldEditExistingImage,
      shouldUseLayerFlow: intent.shouldUseLayerFlow,
      shouldPreserveExistingImage: intent.shouldPreserveExistingImage,
    })}`,
  );
}
