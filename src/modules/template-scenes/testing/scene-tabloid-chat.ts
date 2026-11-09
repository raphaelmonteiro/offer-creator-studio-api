import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { MockSceneDirectorClient } from '../providers/mock-scene-director.client';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { directorAnswer } from './scene-director-harness';
import { PlanOverrides } from './scene-director-fixtures';
import { useFacesHarness } from './scene-faces-harness';

type Harness = ReturnType<typeof useFacesHarness>;

/** Os passos comuns dos specs do Diretor no jornal: pedido pelo chat, plano dado, job de imagem e resposta. */
export function tabloidChat(h: Harness) {
  async function chat(sceneId: string, content: string, extra: Record<string, unknown> = {}) {
    const sent = await h.post(sceneId, content, extra);
    await h
      .directorProcessor(new MockSceneDirectorClient() as never)
      .process({ sceneId, versionId: sent.versionId });
    return { sent, version: await h.versionOf(sent.versionId) };
  }

  async function chatWith(
    sceneId: string,
    content: string,
    plan: PlanOverrides,
    extra: Record<string, unknown> = {},
  ) {
    const sent = await h.post(sceneId, content, extra);
    const { client } = h.directorClient(async () => directorAnswer(plan));
    await h.directorProcessor(client).process({ sceneId, versionId: sent.versionId });
    return { sent, version: await h.versionOf(sent.versionId) };
  }

  const imageJobs = () =>
    h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
  /** A resposta mais recente do assistente na versão (o anúncio antes da imagem, a resposta depois). */
  const assistantOf = async (versionId: string) =>
    (
      await h.dataSource.manager.findOneOrFail(TemplateSceneMessage, {
        where: { versionId, role: 'assistant' },
        order: { createdAt: 'DESC' },
      })
    ).content;
  const faceOf = (sceneId: string, index: number) =>
    h.dataSource.manager.findOneByOrFail(TemplateSceneFace, { sceneId, index });

  /** Roda o job de imagem da versão com o provedor falso e devolve o prompt enviado. */
  async function runImage(sceneId: string, versionId: string, call: 'generate' | 'edit') {
    const fake = h.fakeProvider(async () => h.okResult(0.13));
    await h.processorWith(fake.provider).process(h.job(sceneId, versionId));
    return { fake, prompt: fake[call].mock.calls[0]?.[0]?.prompt as string };
  }

  return { chat, chatWith, imageJobs, assistantOf, faceOf, runImage };
}
