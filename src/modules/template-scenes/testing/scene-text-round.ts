import { DirectorPlan } from '../domain/scene-director-schema';
import { SceneGenerateInput, SceneGenerateResult } from '../providers/scene-image-provider';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { useProcessorHarness } from './scene-processor-harness';

type Harness = ReturnType<typeof useProcessorHarness>;

/** Linha de `metrics.paintedText` como o teste a grava: forma antiga (texto) ou com zona e marca. */
export type PaintedSeed = string | { text: string; zone?: string; unchecked?: boolean };

export interface TextRoundOptions {
  plan: DirectorPlan;
  request?: string;
  env?: Record<string, string>;
  /** `metrics.paintedText` da versão atual antes do pedido. */
  painted?: PaintedSeed[];
  /** Comportamento do provedor de imagem; padrão: sempre uma imagem de US$ 0,10. */
  provider?: (input: SceneGenerateInput, call: number) => Promise<SceneGenerateResult>;
}

/**
 * Um pedido de redesenho sobre uma cena pronta, processado com o juiz dado: devolve a cena, a versão do pedido, as
 * chamadas de imagem e a resposta do chat. `scene` e a versão atual ficam no banco para um segundo pedido.
 */
export async function runTextRound(
  h: Harness,
  judge: { client: SceneVisionClient },
  options: TextRoundOptions,
) {
  const { scene } = await h.readyScene();
  if (options.painted) await seedPainted(h, scene.currentVersionId as string, options.painted);
  const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
    plan: options.plan,
    request: options.request ?? 'coloca uma placa com a frase "Promoção de Páscoa"',
  });
  return processRound(h, judge, { sceneId: scene.id, versionId: queued.id, options });
}

/** Um segundo pedido sobre a cena que o primeiro deixou, com a versão atual dele como base. */
export async function runNextRound(
  h: Harness,
  judge: { client: SceneVisionClient },
  input: { sceneId: string; options: TextRoundOptions },
) {
  const scene = await h.sceneOf(input.sceneId);
  const queued = await h.queueRedraw(scene, {
    plan: input.options.plan,
    request: input.options.request ?? 'coloca mais margaridas no rodapé',
    number: 3,
  });
  return processRound(h, judge, {
    sceneId: scene.id,
    versionId: queued.id,
    options: input.options,
  });
}

async function seedPainted(h: Harness, versionId: string, painted: PaintedSeed[]): Promise<void> {
  const current = await h.versionOf(versionId);
  await h.dataSource.manager.update(
    'template_scene_versions',
    { id: current.id },
    { metrics: { ...current.metrics, paintedText: painted } },
  );
}

async function processRound(
  h: Harness,
  judge: { client: SceneVisionClient },
  input: { sceneId: string; versionId: string; options: TextRoundOptions },
) {
  const { sceneId, versionId, options } = input;
  let call = 0;
  const behavior = options.provider ?? (() => h.okResult(0.1));
  const { provider, edit } = h.fakeProvider((request) => behavior(request, call++));
  await h.processorWith(provider, options.env, judge.client).process(h.job(sceneId, versionId));
  const messages = await h.dataSource.manager.find(TemplateSceneMessage, {
    where: { sceneId, versionId, role: 'assistant' },
  });
  const version = await h.versionOf(versionId);
  return { sceneId, scene: { id: sceneId }, version, edit, reply: messages[0]?.content ?? '' };
}
