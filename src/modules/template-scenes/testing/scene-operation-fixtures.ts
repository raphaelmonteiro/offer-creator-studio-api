import { SceneElement } from '../domain/scene.types';
import { useProcessorHarness } from './scene-processor-harness';

type Harness = ReturnType<typeof useProcessorHarness>;

export const logoEl: SceneElement = {
  id: 'logo-1',
  kind: 'logo',
  name: 'Logo 1',
  x: 0.2,
  y: 0.05,
  w: 0.3,
  aspect: 2,
  rotation: 0,
  z: 1,
  assetId: 'a1',
};
export const textEl: SceneElement = {
  id: 'text-1',
  kind: 'text',
  name: 'Texto 1',
  x: 0.5,
  y: 0.9,
  w: 0.6,
  aspect: 5,
  rotation: 0,
  z: 2,
  text: 'Páscoa',
  fontSize: 7,
  color: '#fff',
};
export const genEl: SceneElement = {
  id: 'gen-1',
  kind: 'generated',
  name: 'Balão',
  x: 0.7,
  y: 0.4,
  w: 0.2,
  aspect: 1,
  rotation: 0,
  z: 3,
  assetId: 'a2',
};

/** Texto da última mensagem do chat da cena. */
export const lastReplyOf = async (h: Harness, sceneId: string): Promise<string> => {
  const messages = await h.messagesOf(sceneId);
  return messages[messages.length - 1].content;
};

/** Provedor que conta as chamadas de imagem, para provar que nenhuma foi feita. */
export const noModelCalls = (h: Harness) => {
  const fake = h.fakeProvider(() => h.okResult());
  return {
    ...fake,
    total: () =>
      fake.generate.mock.calls.length +
      fake.edit.mock.calls.length +
      fake.generateTransparent.mock.calls.length,
  };
};
