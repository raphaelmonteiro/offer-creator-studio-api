import { SceneVisionClient } from '../providers/scene-vision-client';
import { SceneProviderError } from '../providers/scene-image-provider';
import { directorPlan } from '../testing/scene-director-fixtures';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const plan = directorPlan({
  turn_kind: 'pedido_item',
  will_change_image: true,
  reply: 'Vou tirar o coelho.',
  what_to_change: 'tirar o coelho',
});

const verdict = JSON.stringify({
  atendeu: 'sim',
  mudou: 'O coelho saiu.',
  vistos: [],
  nao_vistos: [],
  texto_na_imagem: false,
  emenda: false,
  emenda_descricao: '',
});

describeIfSceneDb('Custo desconhecido nunca soma zero sem marca (R9, banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useDirectorHarness();

  async function turn(
    provider: ReturnType<typeof h.fakeProvider>['provider'],
    vision: SceneVisionClient,
    env: Record<string, string> = {},
  ) {
    const { scene } = await h.readyScene();
    const sent = await h.post(scene.id, 'tira o coelho');
    const { client } = h.directorClient(async () => directorAnswer(plan));
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });
    const published = h.queue.publish.mock.calls.find(([queue]) => queue === 'template_scene.turn');
    await h
      .processorWith(provider, env, vision)
      .process(published![1] as { sceneId: string; versionId: string });
    return h.versionOf(sent.versionId);
  }

  const okVision: SceneVisionClient = {
    compare: jest.fn().mockResolvedValue({
      text: verdict,
      usage: { prompt_tokens: 3000, completion_tokens: 200 },
      requestId: 'r',
      latencyMs: 1,
    }),
  };

  it('juiz que dá erro: custo null na chamada, costUnknown verdadeiro, e o turno segue', async () => {
    const failing: SceneVisionClient = {
      compare: jest.fn().mockRejectedValue(new Error('HTTP 500')),
    };
    const version = await turn(h.fakeProvider(() => h.okResult(0.06)).provider, failing);
    const calls = version.metrics.calls as Array<{ kind: string; costUsd: number | null }>;
    expect(version.status).toBe('ready');
    expect(calls.find((c) => c.kind === 'vision')?.costUsd).toBeNull();
    expect(version.metrics.costUnknown).toBe(true);
  });

  it('juiz que passa do tempo: o mesmo', async () => {
    const hanging: SceneVisionClient = {
      compare: jest.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const version = await turn(h.fakeProvider(() => h.okResult(0.06)).provider, hanging, {
      TEMPLATE_SCENE_VISION_TIMEOUT_MS: '20',
    });
    expect(version.metrics.costUnknown).toBe(true);
  });

  it('imagem que passa do tempo depois de a requisição sair: custo null, não zero, costUnknown verdadeiro', async () => {
    const provider = h.fakeProvider(async () => {
      throw new SceneProviderError('PROVIDER_TIMEOUT', 'passou de 180 s');
    }).provider;
    const version = await turn(provider, okVision);
    const calls = version.metrics.calls as Array<{ kind: string; costUsd: number | null }>;
    expect(version.status).toBe('failed');
    expect(calls[0].costUsd).toBeNull();
    expect(version.metrics.costUnknown).toBe(true);
  });

  it('imagem que dá erro inesperado: o mesmo, custo desconhecido', async () => {
    const provider = h.fakeProvider(async () => {
      throw new Error('socket hang up');
    }).provider;
    const version = await turn(provider, okVision);
    expect(version.metrics.costUnknown).toBe(true);
  });

  it('recusa antes da rede: custo zero e costUnknown não é marcado', async () => {
    const provider = h.fakeProvider(async () => {
      throw new SceneProviderError('PROVIDER_ERROR', 'tamanho fora da tabela', 0);
    }).provider;
    const version = await turn(provider, okVision);
    const calls = version.metrics.calls as Array<{ kind: string; costUsd: number | null }>;
    expect(version.status).toBe('failed');
    expect(calls[0].costUsd).toBe(0);
    expect(version.metrics.costUnknown).toBeUndefined();
  });
});
