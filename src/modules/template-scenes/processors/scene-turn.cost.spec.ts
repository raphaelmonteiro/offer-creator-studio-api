import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { Logger } from '@nestjs/common';
import { OpenAiImageService } from '../../ai/openai-image.service';
import { OpenAiSceneImageProvider } from '../providers/openai-scene-image.provider';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { TemplateScene } from '../entities/template-scene.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import {
  DIRECTOR_CALL_COST,
  directorAnswer,
  useDirectorHarness,
} from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const solidPng = () =>
  sharp({ create: { width: 1920, height: 3840, channels: 3, background: '#468' } })
    .png()
    .toBuffer();
const JUDGE_COST = 0.0004;
const IMAGE_COST = 0.0634;

const judge = (): { client: SceneVisionClient; compare: jest.Mock } => {
  const compare = jest.fn().mockResolvedValue({
    text: JSON.stringify({
      atendeu: 'sim',
      mudou: 'O coelho saiu.',
      vistos: [],
      nao_vistos: [],
      texto_na_imagem: false,
      emenda: false,
      emenda_descricao: '',
    }),
    usage: { prompt_tokens: 3000, completion_tokens: 200 },
    requestId: 'req_judge',
    latencyMs: 600,
  });
  return { client: { compare }, compare };
};

const itemPlan = directorPlan({
  turn_kind: 'pedido_item',
  will_change_image: true,
  reply: 'Vou tirar o coelho.',
  what_to_change: 'tirar o coelho',
  requests: [{ id: null, text: 'tirar o coelho', action: 'open', quote: null }],
});

describeIfSceneDb('Custo registrado por etapa (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useDirectorHarness();
  afterEach(() => jest.restoreAllMocks());

  /** O POST, o Diretor e o job de imagem que ele publicou, rodando de ponta a ponta com provedores simulados. */
  async function fullTurn(
    env: Record<string, string> = {},
    provider = h.fakeProvider(() => h.okResult(IMAGE_COST)).provider,
  ) {
    const { scene } = await h.readyScene();
    const sent = await h.post(scene.id, 'tira o coelho');
    const { client } = h.directorClient(async () => directorAnswer(itemPlan));
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });
    const published = h.queue.publish.mock.calls.find(([queue]) => queue === 'template_scene.turn');
    expect(published).toBeDefined();
    const judging = judge();
    await h
      .processorWith(provider, env, judging.client)
      .process(published![1] as { sceneId: string; versionId: string });
    return { scene, sent, version: await h.versionOf(sent.versionId), judging };
  }

  it('Turno completo: metrics traz o custo e a latência do Diretor, da imagem e do juiz, e totalCostUsd subiu a soma', async () => {
    const before = (await h.readyScene()).scene.totalCostUsd;
    const { scene, version } = await fullTurn();

    const director = version.metrics.director as {
      calls: Array<{ costUsd: number; latencyMs: number }>;
      costUsd: number;
    };
    const calls = version.metrics.calls as Array<{ kind: string; costUsd: number; status: string }>;
    expect(director.calls).toEqual([
      expect.objectContaining({ costUsd: DIRECTOR_CALL_COST, latencyMs: 12, status: 'done' }),
    ]);
    expect(calls.map((c) => [c.kind, c.status, c.costUsd])).toEqual([
      ['edit', 'done', IMAGE_COST],
      ['vision', 'done', JUDGE_COST],
    ]);
    const total = DIRECTOR_CALL_COST + IMAGE_COST + JUDGE_COST;
    expect(version.providerCostUsd).toBeCloseTo(total, 6);
    expect((await h.sceneOf(scene.id)).totalCostUsd - before).toBeCloseTo(total, 6);
    expect(version.latencyMs).toBe(1234);
    expect(version.metrics.costUnknown).toBeUndefined();
    // o Diretor fica fora de metrics.calls: o disjuntor de chamadas pagas só conta imagem e juiz
    expect(calls).toHaveLength(2);
  });

  it('Auditoria: metrics traz o plano do Diretor, o prompt enviado e a resposta do juiz', async () => {
    const { version } = await fullTurn();
    expect(version.metrics.plan).toMatchObject({
      turn_kind: 'pedido_item',
      image: { change: 'tirar o coelho' },
    });
    expect(version.metrics.prompt).toContain('Make exactly one change: tirar o coelho.');
    expect(version.metrics.judge).toMatchObject({
      available: true,
      satisfied: 'sim',
      changed: 'O coelho saiu.',
    });
    expect(version.metrics.director).toBeDefined();
  });

  it('Só o Diretor: uma pergunta respondida custa só o Diretor', async () => {
    const { version, scene } = await h.runTurn('quantos coelhos?', {
      turn_kind: 'pergunta',
      reply: 'Há 3.',
    });
    expect(version.providerCostUsd).toBeCloseTo(DIRECTOR_CALL_COST, 6);
    expect(version.metrics.calls).toBeUndefined();
    expect((await h.sceneOf(scene.id)).totalCostUsd).toBeCloseTo(DIRECTOR_CALL_COST, 6);
  });

  describe('o provedor real, com o SDK simulado', () => {
    const USAGE = {
      input_tokens: 2100,
      output_tokens: 1000,
      input_tokens_details: { image_tokens: 2000, text_tokens: 100 },
    };
    function realProvider(withUsage = true) {
      const service = new OpenAiImageService(new ConfigService({ OPENAI_API_KEY: 'sk-teste' }));
      const edit = jest.fn().mockReturnValue({
        withResponse: async () => ({
          data: { data: [{ b64_json: 'x' }], ...(withUsage ? { usage: USAGE } : {}) },
          response: { headers: { get: () => null } },
          request_id: 'req_img',
        }),
      });
      (service as unknown as { openai: unknown }).openai = {
        images: { edit, generate: jest.fn() },
      };
      return { provider: new OpenAiSceneImageProvider(service, new ConfigService({})), edit };
    }

    it('Preço do modelo da cena: o custo da imagem vem da entrada do gpt-image-2.6-sunburst na tabela, e não é null', async () => {
      const png = await solidPng();
      const { provider, edit } = realProvider();
      edit.mockReturnValue({
        withResponse: async () => ({
          data: { data: [{ b64_json: png.toString('base64') }], usage: USAGE },
          response: { headers: { get: () => null } },
          request_id: 'req_img',
        }),
      });
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { version } = await fullTurn(
        { TEMPLATE_SCENE_IMAGE_MODEL: 'gpt-image-2.6-sunburst' },
        provider,
      );
      const calls = version.metrics.calls as Array<{ kind: string; costUsd: number }>;
      expect(calls[0]).toMatchObject({ kind: 'edit', costUsd: 0.0465 });
      expect(version.status).toBe('ready');
    });

    it('Modelo sem preço conferido: nenhuma requisição sai, a versão fica failed com PROVIDER_ERROR, a atual não muda e há erro no log', async () => {
      const { provider, edit } = realProvider();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { scene } = await h.readyScene();
      const currentBefore = scene.currentVersionId;
      const sent = await h.post(scene.id, 'tira o coelho');
      const { client } = h.directorClient(async () => directorAnswer(itemPlan));
      await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

      await h
        .processorWith(provider, { TEMPLATE_SCENE_IMAGE_MODEL: 'gpt-image-2.5-flare' })
        .process({ sceneId: scene.id, versionId: sent.versionId });

      expect(edit).not.toHaveBeenCalled();
      expect(await h.versionOf(sent.versionId)).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_ERROR',
      });
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(currentBefore);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('preço'));
    });

    it('Resposta sem usage: o turno segue, metrics.costUnknown fica verdadeiro e há erro no log', async () => {
      const png = await solidPng();
      const { provider, edit } = realProvider(false);
      edit.mockReturnValue({
        withResponse: async () => ({
          data: { data: [{ b64_json: png.toString('base64') }] },
          response: { headers: { get: () => null } },
          request_id: 'req_img',
        }),
      });
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const { version } = await fullTurn(
        { TEMPLATE_SCENE_IMAGE_MODEL: 'gpt-image-2.6-sunburst' },
        provider,
      );

      expect(version.status).toBe('ready');
      expect(version.metrics.costUnknown).toBe(true);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Custo desconhecido'));
    });
  });

  it('o custo do turno nunca bloqueia o uso: a cena segue livre depois de um turno caro', async () => {
    const { scene } = await fullTurn();
    await h.dataSource.manager.update(TemplateScene, { id: scene.id }, { totalCostUsd: 9999 });
    await expect(h.post(scene.id, 'outra mensagem')).resolves.toBeDefined();
  });
});
