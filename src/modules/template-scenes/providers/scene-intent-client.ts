import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { IntentCompletionInput, IntentCompletionResult } from '../../ai/openai-intent.service';
import { OpenAiIntentService } from '../../ai/openai-intent.service';
import { MockSceneIntentClient } from './mock-scene-intent.client';

/** Token de injeção do cliente de intenção da cena (`mock` ou `openai`, junto com o provedor de imagem). */
export const SCENE_INTENT_CLIENT = 'SCENE_INTENT_CLIENT';

/** A chamada ao modelo, mais a mensagem e a marcação em claro, que só o `mock` lê. */
export interface SceneIntentCall extends IntentCompletionInput {
  message: string;
  marked: boolean;
}

/** O que a cena precisa do modelo de intenção: um JSON a partir do texto do cliente. */
export interface SceneIntentClient {
  classify(input: SceneIntentCall): Promise<IntentCompletionResult>;
}

/** Mesmo critério do provedor de imagem e da visão: `openai` explícito para pagar; o resto cai no `mock`. */
export function createSceneIntentClient(
  config: ConfigService,
  intent: OpenAiIntentService,
): SceneIntentClient {
  const wanted = config.get<string>('TEMPLATE_SCENE_IMAGE_PROVIDER', 'mock');
  if (wanted === 'openai') return intent;
  if (wanted !== 'mock') {
    new Logger('SceneIntentClient').warn(`Provedor "${wanted}" desconhecido; intenção em mock`);
  }
  return new MockSceneIntentClient();
}
