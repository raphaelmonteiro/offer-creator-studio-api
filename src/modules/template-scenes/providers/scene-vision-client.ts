import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { OpenAiVisionService } from '../../ai/openai-vision.service';
import { VisionCompareInput, VisionCompareResult } from '../../ai/openai-vision.service';
import { MockSceneVisionClient } from './mock-scene-vision.client';

/** Token de injeção do cliente de visão da cena (`mock` ou `openai`, junto com o provedor de imagem). */
export const SCENE_VISION_CLIENT = 'SCENE_VISION_CLIENT';

/** O que a cena precisa do modelo de visão: comparar a imagem inteira antes e depois. */
export interface SceneVisionClient {
  compare(input: VisionCompareInput): Promise<VisionCompareResult>;
}

/** Mesmo critério do provedor de imagem: `openai` explícito para pagar; o resto cai no `mock`. */
export function createSceneVisionClient(
  config: ConfigService,
  vision: OpenAiVisionService,
): SceneVisionClient {
  const wanted = config.get<string>('TEMPLATE_SCENE_IMAGE_PROVIDER', 'mock');
  if (wanted === 'openai') return vision;
  if (wanted !== 'mock') {
    new Logger('SceneVisionClient').warn(`Provedor "${wanted}" desconhecido; visão em mock`);
  }
  return new MockSceneVisionClient();
}
