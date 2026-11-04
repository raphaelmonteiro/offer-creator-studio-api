import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAiImageService } from '../../ai/openai-image.service';
import { MockSceneImageProvider } from './mock-scene-image.provider';
import { OpenAiSceneImageProvider } from './openai-scene-image.provider';
import { SceneImageProvider } from './scene-image-provider';

/**
 * `TEMPLATE_SCENE_IMAGE_PROVIDER`: `openai` (real, pago) ou `mock` (padrão, sem custo, D-2).
 * Qualquer outro valor, ou a variável ausente, cai no `mock`: o caminho pago exige pedido explícito.
 */
export function createSceneImageProvider(
  config: ConfigService,
  images: OpenAiImageService,
): SceneImageProvider {
  const wanted = config.get<string>('TEMPLATE_SCENE_IMAGE_PROVIDER', 'mock');
  if (wanted === 'openai') return new OpenAiSceneImageProvider(images, config);
  if (wanted !== 'mock') {
    new Logger('SceneImageProvider').warn(
      `TEMPLATE_SCENE_IMAGE_PROVIDER "${wanted}" desconhecido; usando mock`,
    );
  }
  return new MockSceneImageProvider(config);
}
