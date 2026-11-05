import { Logger } from '@nestjs/common';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneIntent } from '../domain/scene-intent';
import { SceneElement } from '../domain/scene.types';
import { mockIntentService } from '../testing/scene-intent-fixtures';
import { errorOf } from '../testing/scene-test-helpers';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { useTurnServiceHarness } from '../testing/scene-turn-service-harness';
import { SceneTurnService } from './scene-turn.service';

const RECT = { x: 0.3, y: 0.4, w: 0.3, h: 0.2 };
const base: SceneIntent = {
  action: 'edit',
  zone: null,
  object: null,
  subject: null,
  imagePrompt: null,
  relativePlace: false,
  layer: null,
  text: null,
};
/** Resposta do modelo com custo conhecido (1000 tokens de entrada e 300 de saída = US$ 0,00025). */
const modelSays = (extra: Partial<SceneIntent>) => ({
  text: JSON.stringify({ ...base, ...extra }),
  usage: { prompt_tokens: 1000, completion_tokens: 300 },
  requestId: 'req_i',
  latencyMs: 640,
});
const V3 =
  'gere uma segunda imagem, de fundo para substituir essa, eu nao gostei, pois o header está completamente diferente do body e do footer. Preciso de uma imagem q tenha harmonia, pense em um template de pascoa para com ovos de pascoa e um coelho de pascoa, em um cenario que tenha referencia a essa epoca';
const logo: SceneElement = {
  id: 'logo-1',
  kind: 'logo',
  name: 'Logo 1',
  x: 0.2,
  y: 0.1,
  w: 0.3,
  aspect: 2,
  rotation: 0,
  z: 1,
  assetId: 'a',
};
const confirm = (asked: { assistantMessage: { id: string } | null }) => ({
  content: 'Confirmar',
  confirmGlobal: true,
  replyToMessageId: asked.assistantMessage!.id,
});

describeIfSceneDb('SceneTurnService: reconhecimento de intenção por modelo (D-19)', () => {
  const h = useTurnServiceHarness();

  describe('quando o modelo roda', () => {
    it('sinais estruturados não chamam o modelo: sem versão pronta, elemento selecionado e anexo', async () => {
      const empty = await h.newScene('Intenção sem versão');
      await h.send(empty.id, { content: 'campo verde com sol' });
      const scene = await h.readyScene('Intenção estrutural', [logo]);
      const moved = await h.send(scene.id, {
        content: 'passa para a direita',
        targetElementId: 'logo-1',
      });
      expect(moved.operation).toBe('set_layer');
      expect(h.intentClassify).not.toHaveBeenCalled();
    });

    it('a confirmação não chama o modelo e segue o plano guardado, com a frase literal da versão 3', async () => {
      const scene = await h.readyScene('Intenção confirma v3');
      const asked = await h.send(scene.id, { content: V3 });
      expect(asked.operation).toBe('needs_confirmation_new_image');
      expect(h.intentClassify).toHaveBeenCalledTimes(1);

      const confirmed = await h.send(scene.id, confirm(asked), asked.revision);

      expect(confirmed.operation).toBe('new_image');
      expect(h.intentClassify).toHaveBeenCalledTimes(1);
      const queued = (await h.versionsOf(scene.id))[2];
      expect(queued.metrics.plan).toEqual({ operation: 'new_image', instruction: V3 });
      expect(queued.metrics.intent).toBeUndefined();
      expect(queued.providerCostUsd).toBe(0);
    });

    it.each([
      'gere outra imagem com o coelho no cabeçalho',
      'faça uma nova arte com ovos no rodapé',
      'refaz do zero com cesta no meio',
      'gere outra imagem e adicione um coelho',
      'gere outra imagem com espaço para o logo',
    ])('R23, "%s": a confirmação é a imagem nova, nunca outra operação', async (content) => {
      const scene = await h.readyScene('Intenção R23');
      const asked = await h.send(scene.id, { content });
      expect(asked.operation).toBe('needs_confirmation_new_image');

      const confirmed = await h.send(scene.id, confirm(asked), asked.revision);

      expect(confirmed).toMatchObject({ operation: 'new_image', jobId: 'job-1' });
    });
  });

  describe('a marcação manda', () => {
    it('o modelo devolve outra zona ou new_image, e o alvo continua a área marcada', async () => {
      const scene = await h.readyScene('Intenção marcação');
      h.intentClassify.mockResolvedValueOnce(modelSays({ action: 'new_image', zone: 'footer' }));

      const result = await h.send(scene.id, { content: 'gere outra imagem', region: RECT });

      expect(result.operation).toBe('local_edit');
      const queued = (await h.versionsOf(scene.id))[1];
      expect(queued.requestedRegion).toEqual(RECT);
      expect(queued.metrics.plan).toMatchObject({ target: { kind: 'rect', rect: RECT } });
    });
  });

  describe('falha do modelo', () => {
    const failures: Array<[string, () => void]> = [
      [
        'JSON inválido',
        () => h.intentClassify.mockResolvedValueOnce({ ...modelSays({}), text: 'oi' }),
      ],
      [
        'ação fora da lista',
        () => h.intentClassify.mockResolvedValueOnce(modelSays({ action: 'x' as never })),
      ],
      [
        'texto exato fora da mensagem',
        () =>
          h.intentClassify.mockResolvedValueOnce(
            modelSays({ action: 'set_text', text: { value: 'Natal', placement: 'none' } }),
          ),
      ],
      ['erro do provedor', () => h.intentClassify.mockRejectedValueOnce(new Error('503'))],
    ];

    it.each(failures)(
      '%s, sem marcação: pede a marcação, sem job e sem imagem',
      async (_label, arm) => {
        const scene = await h.readyScene('Intenção falha sem marcação');
        arm();

        const result = await h.send(scene.id, { content: 'deixa mais bonito' });

        expect(result).toMatchObject({ jobId: null, operation: 'needs_region', revision: 1 });
        expect(result.assistantMessage?.content).toContain('Não entendi o pedido');
        expect(h.publish).not.toHaveBeenCalled();
        expect((await h.versionsOf(scene.id))[1]).toMatchObject({ status: 'rejected' });
      },
    );

    it.each(failures)('%s, com marcação: pergunta se edita a área marcada', async (_label, arm) => {
      const scene = await h.readyScene('Intenção falha com marcação');
      arm();

      const asked = await h.send(scene.id, { content: 'deixa mais bonito', region: RECT });

      expect(asked).toMatchObject({ jobId: null, operation: 'needs_confirmation_edit' });
      expect(asked.assistantMessage?.content).toContain('edite a área marcada');
      expect(h.publish).not.toHaveBeenCalled();
      const rejected = (await h.versionsOf(scene.id))[1];
      expect(rejected.metrics.pendingConfirmation).toMatchObject({
        kind: 'edit',
        request: 'deixa mais bonito',
        target: { kind: 'rect', rect: RECT },
      });
    });

    it('confirmada a pergunta, a edição roda com o alvo e a frase guardados, sem chamar o modelo de novo', async () => {
      const scene = await h.readyScene('Intenção confirma edição');
      h.intentClassify.mockRejectedValueOnce(new Error('timeout'));
      const asked = await h.send(scene.id, { content: 'deixa mais bonito', region: RECT });

      const confirmed = await h.send(scene.id, confirm(asked), asked.revision);

      expect(confirmed).toMatchObject({ operation: 'local_edit', jobId: 'job-1' });
      expect(h.intentClassify).toHaveBeenCalledTimes(1);
      const queued = (await h.versionsOf(scene.id))[2];
      expect(queued.requestedRegion).toEqual(RECT);
      expect(queued.metrics.plan).toMatchObject({
        operation: 'local_edit',
        target: { kind: 'rect', rect: RECT },
        instruction: 'deixa mais bonito',
        remove: false,
      });
    });

    it('tempo esgotado: o POST segue 202, sem imagem, e o custo fica nulo', async () => {
      const scene = await h.readyScene('Intenção tempo');
      const slow = new SceneTurnService(
        h.dataSource,
        h.locks,
        { publish: h.publish } as unknown as AnimationQueueService,
        mockIntentService(
          { classify: () => new Promise(() => undefined) },
          { TEMPLATE_SCENE_INTENT_TIMEOUT_MS: '50' },
        ),
      );

      const result = await slow.sendMessage(
        scene.id,
        { content: 'deixa mais bonito', expectedRevision: 0 } as never,
        null,
      );

      expect(result).toMatchObject({ jobId: null, operation: 'needs_region' });
      expect(h.publish).not.toHaveBeenCalled();
      const rejected = (await h.versionsOf(scene.id))[1];
      expect(rejected.metrics.intent).toMatchObject({ status: 'timeout', costUsd: null });
      expect(rejected.providerCostUsd).toBe(0);
    });
  });

  describe('custo da intenção', () => {
    it('soma na versão e na cena, fica em metrics.intent e não conta como chamada de imagem', async () => {
      const scene = await h.readyScene('Intenção custo');
      h.intentClassify.mockResolvedValueOnce(modelSays({ action: 'global_adjust' }));

      const asked = await h.send(scene.id, { content: 'deixa tudo mais quente' });

      expect(asked.operation).toBe('needs_confirmation_global');
      const rejected = (await h.versionsOf(scene.id))[1];
      expect(rejected.providerCostUsd).toBeCloseTo(0.00025, 6);
      expect(rejected.metrics.intent).toEqual({
        model: 'gpt-6-luna',
        status: 'ok',
        costUsd: 0.00025,
        latencyMs: 640,
        requestId: 'req_i',
      });
      expect(rejected.metrics.calls).toBeUndefined();
      expect((await h.sceneOf(scene.id)).totalCostUsd).toBeCloseTo(0.00025, 6);
    });

    it('com job, a versão nasce com o custo da intenção e sem chamadas de imagem', async () => {
      const scene = await h.readyScene('Intenção custo job');
      h.intentClassify.mockResolvedValueOnce(
        modelSays({ action: 'add_element', subject: 'balão', imagePrompt: 'um balão' }),
      );

      const queued = await h.send(scene.id, { content: 'adiciona um balão' });

      expect(queued).toMatchObject({ operation: 'add_element', jobId: 'job-1' });
      const version = (await h.versionsOf(scene.id))[1];
      expect(version.providerCostUsd).toBeCloseTo(0.00025, 6);
      expect(version.metrics.intent).toMatchObject({ status: 'ok', costUsd: 0.00025 });
      expect(version.metrics.calls).toBeUndefined();
    });

    it('saída inválida cobra o que o provedor cobrou, e erro sem usage não soma nada', async () => {
      const scene = await h.readyScene('Intenção custo inválida');
      h.intentClassify.mockResolvedValueOnce({ ...modelSays({}), text: 'oi' });
      await h.send(scene.id, { content: 'x y z' });
      h.intentClassify.mockRejectedValueOnce(new Error('503'));
      await h.send(scene.id, { content: 'a b c' }, 1);

      const [, invalid, failed] = await h.versionsOf(scene.id);
      expect(invalid.metrics.intent).toMatchObject({ status: 'invalid', costUsd: 0.00025 });
      expect(failed.metrics.intent).toMatchObject({ status: 'error', costUsd: null });
      expect(failed.providerCostUsd).toBe(0);
      expect((await h.sceneOf(scene.id)).totalCostUsd).toBeCloseTo(0.00025, 6);
    });
  });

  describe('chamada fora do lock, com nova conferência', () => {
    it('o lock da cena fica livre durante a chamada ao modelo', async () => {
      const scene = await h.readyScene('Intenção lock livre');
      let lockedDuringCall: boolean | null = null;
      h.intentClassify.mockImplementationOnce(async () => {
        try {
          await h.dataSource.transaction(async (manager) => {
            await manager.query('SELECT id FROM template_scenes WHERE id = $1 FOR UPDATE NOWAIT', [
              scene.id,
            ]);
          });
          lockedDuringCall = false;
        } catch {
          lockedDuringCall = true;
        }
        return modelSays({ action: 'global_adjust' });
      });

      await h.send(scene.id, { content: 'deixa tudo mais quente' });

      expect(lockedDuringCall).toBe(false);
    });

    it('a revisão mudou durante a chamada: 409 REVISION_CONFLICT, nada é gravado, e o custo vai ao log', async () => {
      const scene = await h.readyScene('Intenção revisão');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      h.intentClassify.mockImplementationOnce(async () => {
        await h.dataSource.query(
          'UPDATE template_scenes SET revision = revision + 1 WHERE id = $1',
          [scene.id],
        );
        return modelSays({ action: 'global_adjust' });
      });

      expect(await errorOf(h.send(scene.id, { content: 'deixa tudo mais quente' }))).toMatchObject({
        status: 409,
        code: 'REVISION_CONFLICT',
      });

      expect(await h.versionsOf(scene.id)).toHaveLength(1);
      expect((await h.sceneOf(scene.id)).totalCostUsd).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Intenção paga e descartada'));
      warn.mockRestore();
    });

    it('outra versão entrou em curso durante a chamada: 409 SCENE_BUSY, sem job', async () => {
      const scene = await h.readyScene('Intenção ocupada');
      h.intentClassify.mockImplementationOnce(async () => {
        await h.dataSource.manager.insert(TemplateSceneVersion, {
          sceneId: scene.id,
          number: 2,
          operation: 'local_edit',
          status: 'queued',
          correlationId: '00000000-0000-4000-8000-000000000002',
        } as never);
        return modelSays({ action: 'global_adjust' });
      });

      expect(await errorOf(h.send(scene.id, { content: 'deixa tudo mais quente' }))).toMatchObject({
        status: 409,
      });
      expect(h.publish).not.toHaveBeenCalled();
    });

    it('conflito antes do modelo (revisão errada): o modelo nem é chamado', async () => {
      const scene = await h.readyScene('Intenção sem pagar à toa');
      expect(
        await errorOf(h.send(scene.id, { content: 'deixa tudo mais quente' }, 7)),
      ).toMatchObject({
        status: 409,
        code: 'REVISION_CONFLICT',
      });
      expect(h.intentClassify).not.toHaveBeenCalled();
    });
  });
});
