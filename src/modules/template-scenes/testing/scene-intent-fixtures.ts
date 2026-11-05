import { ConfigService } from '@nestjs/config';
import { MockSceneIntentClient } from '../providers/mock-scene-intent.client';
import { SceneIntentClient } from '../providers/scene-intent-client';
import { SceneIntentService } from '../services/scene-intent.service';

/** Serviço de intenção dos testes: o `mock` (conjunto de avaliação e marcadores), sem rede e sem custo. */
export function mockIntentService(
  client: SceneIntentClient = new MockSceneIntentClient(),
  env: Record<string, string> = {},
): SceneIntentService {
  return new SceneIntentService(new ConfigService(env), client);
}
