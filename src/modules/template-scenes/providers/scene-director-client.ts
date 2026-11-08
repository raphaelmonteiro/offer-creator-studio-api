import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type {
  DirectorCompletionInput,
  DirectorCompletionResult,
} from '../../ai/openai-director.service';
import { OpenAiDirectorService } from '../../ai/openai-director.service';
import { MockSceneDirectorClient } from './mock-scene-director.client';

/** Token de injeção do cliente do Diretor da cena (`mock` ou `openai`, junto com o provedor de imagem). */
export const SCENE_DIRECTOR_CLIENT = 'SCENE_DIRECTOR_CLIENT';

/** O estado da conversa que só o `mock` lê para escolher o plano (o `openai` recebe o texto e a imagem). */
export interface DirectorScript {
  /** A mensagem atual do cliente, literal. */
  message: string;
  /** A cena já tem imagem. */
  hasImage: boolean;
  /** A mensagem trouxe marcação (retângulo, pincel, laço ou zona). */
  marked: boolean;
  /** Itens em aberto da lista do que o cliente pediu. */
  openRequests: Array<{ id: string; text: string }>;
  /** Camadas da imagem atual. */
  layers: Array<{ id: string; kind: string; name: string }>;
  /** A mensagem anexou uma logo. */
  hasLogoAttachment: boolean;
}

/** A chamada ao modelo, mais o estado em claro, que só o `mock` lê. */
export interface SceneDirectorCall extends DirectorCompletionInput {
  script: DirectorScript;
}

/** O que a cena precisa do Diretor: um JSON de plano a partir do contexto. */
export interface SceneDirectorClient {
  plan(input: SceneDirectorCall): Promise<DirectorCompletionResult>;
}

/** Mesmo critério do provedor de imagem e do juiz: `openai` explícito para pagar; o resto cai no `mock`. */
export function createSceneDirectorClient(
  config: ConfigService,
  director: OpenAiDirectorService,
): SceneDirectorClient {
  const wanted = config.get<string>('TEMPLATE_SCENE_IMAGE_PROVIDER', 'mock');
  if (wanted === 'openai') return director;
  if (wanted !== 'mock') {
    new Logger('SceneDirectorClient').warn(`Provedor "${wanted}" desconhecido; Diretor em mock`);
  }
  return new MockSceneDirectorClient();
}
