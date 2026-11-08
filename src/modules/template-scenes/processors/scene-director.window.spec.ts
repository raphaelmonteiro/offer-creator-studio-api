import { Client } from 'pg';
import { TEMPLATE_SCENE_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { REDRAW_NOTICE } from '../scene-texts';
import { directorPlan } from '../testing/scene-director-fixtures';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb, SCENE_DB_URL } from '../testing/scene-test-db';

const RECT = { region: { x: 0.1, y: 0.6, w: 0.3, h: 0.2 } };
const imagePlan = (
  turn_kind:
    | 'pedido_item'
    | 'pedido_ajuste_geral'
    | 'pedido_composicao'
    | 'imagem_nova'
    | 'reclamacao',
  text = 'mudar a imagem',
) =>
  directorPlan({
    turn_kind,
    will_change_image: true,
    reply: 'Vou fazer o que você pediu.',
    what_to_change: 'mudar a imagem',
    requests: [{ id: null, text, action: 'open', quote: null }],
  });

describeIfSceneDb('Janela de 5 s com Parar (banco chroma_x_e2e)', () => {
  const h = useDirectorHarness();
  const imageJobs = () =>
    h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
  const assistants = async (sceneId: string) =>
    (
      await h.dataSource.manager.find(TemplateSceneMessage, {
        where: { sceneId, role: 'assistant' },
        order: { createdAt: 'ASC' },
      })
    ).map((m) => m.content);

  describe('tem janela', () => {
    it.each([
      ['Janela no pedido sem marcação', 'deixa tudo mais quente', 'pedido_ajuste_geral'],
      ['Item por texto espera', 'tira o coelho da direita do rodapé', 'pedido_item'],
      ['pedido de composição sem marcação', 'coloca os ovos no rodapé', 'pedido_composicao'],
    ] as const)(
      '%s: anúncio gravado, contagem em windowEndsAt e job atrasado em 5 s',
      async (_name, message, kind) => {
        const before = Date.now();
        const { scene, version } = await h.runTurn(message, imagePlan(kind, message));

        expect(version).toMatchObject({ status: 'queued', step: null, operation: 'redraw' });
        const endsAt = new Date(version.metrics.windowEndsAt as string).getTime();
        expect(endsAt).toBeGreaterThanOrEqual(before + 5000);
        expect(endsAt).toBeLessThan(Date.now() + 5100);
        expect(imageJobs()).toHaveLength(1);
        const [, data, options] = imageJobs()[0];
        expect(data).toEqual({ sceneId: scene.id, versionId: version.id });
        expect(options).toMatchObject({
          retryLimit: 0,
          startAfterSeconds: 5,
          expireInSeconds: 905,
        });
        expect(await assistants(scene.id)).toEqual([
          `Vou fazer o que você pediu. ${REDRAW_NOTICE}`,
        ]);
        expect(version.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
      },
    );

    it('Primeira imagem espera: a cena nova também tem janela, e Parar cancela sem chamada de imagem', async () => {
      const { scene, version } = await h.runTurn(
        'campo verde com sol à direita',
        imagePlan('pedido_item', 'campo verde com sol'),
        {
          noImage: true,
        },
      );
      expect(version).toMatchObject({ status: 'queued', step: null, operation: 'generate' });
      expect(imageJobs()[0][2]).toMatchObject({ startAfterSeconds: 5 });

      const { provider, generate } = h.fakeProvider(async () => h.okResult());
      const cancelled = await h.turns().cancel(scene.id, version.id);
      await h.processorWith(provider).process({ sceneId: scene.id, versionId: version.id });

      expect(cancelled.status).toBe('cancelled');
      expect(generate).not.toHaveBeenCalled();
      expect((await h.versionOf(version.id)).status).toBe('cancelled');
    });

    it('Imagem nova com marcação: tem janela, o anúncio avisa que a área não vale, e o provedor receberia generate sem markup', async () => {
      const { scene, version } = await h.runTurn(
        'gere outra imagem',
        imagePlan('imagem_nova', 'gere outra imagem'),
        {
          extra: RECT,
        },
      );
      expect(version).toMatchObject({ status: 'queued', step: null, operation: 'generate' });
      expect(version.requestedRegion).toBeNull();
      expect(version.requestedMask).toBeNull();
      expect(imageJobs()[0][2]).toMatchObject({ startAfterSeconds: 5 });
      expect(await assistants(scene.id)).toEqual([
        'Vou fazer o que você pediu. A área marcada não vale para uma imagem nova.',
      ]);
    });

    it('Reclamação com marcação espera', async () => {
      const { version } = await h.runTurn(
        'essa árvore ficou feia',
        imagePlan('reclamacao', 'árvore feia'),
        {
          extra: RECT,
        },
      );
      expect(imageJobs()[0][2]).toMatchObject({ startAfterSeconds: 5 });
      expect(version.requestedRegion).toMatchObject(RECT.region);
      expect(version.metrics.windowEndsAt).toBeDefined();
    });

    it('Elemento selecionado não é marcação: tem janela, e o provedor não recebe markup', async () => {
      const { scene } = await h.readyScene({
        elements: [
          {
            id: 'logo-1',
            kind: 'logo',
            name: 'Logo 1',
            x: 0.5,
            y: 0.1,
            w: 0.3,
            aspect: 2,
            rotation: 0,
            z: 1,
          },
        ],
      });
      const sent = await h.post(scene.id, 'deixa tudo mais quente', { targetElementId: 'logo-1' });
      const { client } = h.directorClient(async () =>
        directorAnswer(imagePlan('pedido_ajuste_geral', 'tudo mais quente')),
      );
      await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

      const version = await h.versionOf(sent.versionId);
      expect(imageJobs()[0][2]).toMatchObject({ startAfterSeconds: 5 });
      expect(version.targetElementId).toBe('logo-1');
      expect(version.requestedRegion).toBeNull();
      expect(version.requestedMask).toBeNull();
    });
  });

  describe('não tem janela', () => {
    it.each([
      ['Pedido com marcação não espera', RECT, 'tira isso daqui'],
      ['Zona não espera', { zone: 'footer' }, 'mais flores aqui'],
      [
        'pincel',
        {
          mask: {
            kind: 'brush',
            radius: 0.05,
            strokes: [
              [
                { x: 0.3, y: 0.3 },
                { x: 0.5, y: 0.4 },
              ],
            ],
          },
        },
        'tira isso',
      ],
    ])('%s: o job é publicado sem atraso e sem windowEndsAt', async (_name, extra, message) => {
      const { version } = await h.runTurn(message, imagePlan('pedido_item', message), { extra });
      expect(version).toMatchObject({ status: 'queued', step: null });
      expect(imageJobs()).toHaveLength(1);
      expect(imageJobs()[0][2]).not.toHaveProperty('startAfterSeconds');
      expect(imageJobs()[0][2]).toMatchObject({ expireInSeconds: 900 });
      expect(version.metrics.windowEndsAt).toBeUndefined();
    });

    it('pergunta não chama imagem e não tem janela: nenhum job de imagem é publicado', async () => {
      const { version } = await h.runTurn('quantos coelhos?', {
        turn_kind: 'pergunta',
        reply: 'Há 3.',
      });
      expect(version.status).toBe('rejected');
      expect(imageJobs()).toHaveLength(0);
    });
  });

  describe('Parar', () => {
    it('Parar na janela: a versão fica cancelled, nenhuma imagem é chamada, a atual não muda e o envio volta', async () => {
      const { scene, version } = await h.runTurn(
        'deixa tudo mais quente',
        imagePlan('pedido_ajuste_geral', 'tudo mais quente'),
      );
      const currentBefore = (await h.sceneOf(scene.id)).currentVersionId;

      const cancelled = await h.turns().cancel(scene.id, version.id);
      const { provider, generate, edit } = h.fakeProvider(async () => h.okResult());
      // o job atrasado entra, vê a versão fora de queued e sai
      await h.processorWith(provider).process({ sceneId: scene.id, versionId: version.id });

      expect(cancelled.status).toBe('cancelled');
      expect(generate).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
      expect((await h.versionOf(version.id)).status).toBe('cancelled');
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(currentBefore);
      await expect(h.post(scene.id, 'outra')).resolves.toBeDefined();
    });

    it('Parar na janela fecha o pedido do turno e o do turno anterior, e o pedido seguinte não cobra nenhum (B2)', async () => {
      const older = {
        id: 'p1',
        text: 'um rio no meio',
        status: 'open' as const,
        sourceMessageId: 'm-anterior',
        updatedAt: '2026-11-06T12:00:00.000Z',
      };
      const { scene, version } = await h.runTurn(
        'coloca um trator vermelho no campo',
        imagePlan('pedido_item', 'trator vermelho no campo'),
        { brief: [older] },
      );
      expect((await h.sceneOf(scene.id)).brief.map((item) => item.status)).toEqual([
        'open',
        'open',
      ]);

      await h.turns().cancel(scene.id, version.id);

      const stopped = await h.sceneOf(scene.id);
      expect(stopped.brief.map((item) => [item.id, item.status])).toEqual([
        ['p1', 'superseded'],
        ['p2', 'superseded'],
      ]);
      expect((await h.versionOf(version.id)).metrics.briefSuperseded).toEqual(['p1', 'p2']);
    });

    it('Parar repetido não muda a lista de novo', async () => {
      const { scene, version } = await h.runTurn(
        'coloca um trator vermelho no campo',
        imagePlan('pedido_item', 'trator vermelho no campo'),
      );
      await h.turns().cancel(scene.id, version.id);
      const once = (await h.sceneOf(scene.id)).brief;
      await expect(h.turns().cancel(scene.id, version.id)).rejects.toMatchObject({
        response: { code: 'VERSION_NOT_CANCELLABLE' },
      });
      expect((await h.sceneOf(scene.id)).brief).toEqual(once);
    });

    it('Mensagem durante a janela: 409 SCENE_BUSY', async () => {
      const { scene } = await h.runTurn(
        'deixa tudo mais quente',
        imagePlan('pedido_ajuste_geral', 'tudo mais quente'),
      );
      await expect(h.post(scene.id, 'outra')).rejects.toMatchObject({
        response: { code: 'SCENE_BUSY' },
      });
    });

    it('Parar o que já terminou: 409 VERSION_NOT_CANCELLABLE', async () => {
      const { scene, version } = await h.runTurn('quantos coelhos?', {
        turn_kind: 'pergunta',
        reply: 'Há 3.',
      });
      await expect(h.turns().cancel(scene.id, version.id)).rejects.toMatchObject({
        response: { code: 'VERSION_NOT_CANCELLABLE' },
      });
    });
  });

  describe('evento', () => {
    it('o anúncio e windowEndsAt gravados emitem version.step com step nulo e status queued', async () => {
      const client = new Client({ connectionString: SCENE_DB_URL });
      await client.connect();
      const events: Array<Record<string, unknown>> = [];
      client.on('notification', (n) => events.push(JSON.parse(n.payload ?? '{}')));
      await client.query(`LISTEN ${TEMPLATE_SCENE_EVENTS_CHANNEL}`);
      try {
        const { scene, version } = await h.runTurn(
          'deixa tudo mais quente',
          imagePlan('pedido_ajuste_geral', 'tudo mais quente'),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        const mine = events.filter(
          (event) => event.sceneId === scene.id && event.versionId === version.id,
        );
        expect(mine.map((e) => [e.kind, e.step, e.status])).toEqual([
          ['version.step', 'reading', 'queued'],
          ['version.step', null, 'queued'],
        ]);
        expect((mine[1].revision as number) > (mine[0].revision as number)).toBe(true);
      } finally {
        await client.end();
      }
    });
  });
});
