import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { REDRAW_NOTICE } from '../scene-texts';
import { directorPlan } from '../testing/scene-director-fixtures';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const NOTICE =
  'Cada pedido redesenha a imagem inteira, então detalhes que você não pediu podem variar. Se não gostar, é só pedir para voltar.';

describeIfSceneDb('Aviso do redesenho (banco chroma_x_e2e)', () => {
  const h = useDirectorHarness();

  /** Uma mensagem no turno da cena: POST real, Diretor com o plano dado e o consumer rodando. */
  async function step(
    sceneId: string,
    message: string,
    kind: 'pedido_item' | 'pedido_ajuste_geral' | 'imagem_nova',
    requestText: string,
  ) {
    const sent = await h.post(sceneId, message);
    const { client } = h.directorClient(async () =>
      directorAnswer(
        directorPlan({
          turn_kind: kind,
          will_change_image: true,
          reply: 'Vou fazer o que você pediu.',
          what_to_change: requestText,
          requests: [{ id: null, text: requestText, action: 'open', quote: null }],
        }),
      ),
    );
    await h.directorProcessor(client).process({ sceneId, versionId: sent.versionId });
    const announcement = await h.dataSource.manager.findOne(TemplateSceneMessage, {
      where: { versionId: sent.versionId, role: 'assistant' },
    });
    return {
      sent,
      version: await h.versionOf(sent.versionId),
      announcement: announcement?.content ?? '',
    };
  }

  /** "Parar": libera a cena sem chamar imagem (o aviso, se houve, já está gravado). */
  const stop = (sceneId: string, versionId: string) => h.turns().cancel(sceneId, versionId);

  it('o texto do aviso é o literal do requisito', () => {
    expect(REDRAW_NOTICE).toBe(NOTICE);
  });

  it('Primeira edição: o anúncio traz o aviso uma vez, e a primeira mensagem da cena não o trouxe', async () => {
    const first = await h.runTurn(
      'campo verde com sol',
      directorPlan({
        turn_kind: 'imagem_nova',
        will_change_image: true,
        reply: 'Vou criar a imagem.',
        what_to_put: 'campo verde com sol',
        requests: [{ id: null, text: 'campo verde com sol', action: 'open', quote: null }],
      }),
      { noImage: true },
    );
    const firstAnnouncement = await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
      versionId: first.sent.versionId,
      role: 'assistant',
    });
    expect(firstAnnouncement.content).toBe('Vou criar a imagem.');
    expect(first.version.metrics.notice).toBeUndefined();

    const { scene } = await h.readyScene();
    const edit = await step(scene.id, 'tira o coelho', 'pedido_item', 'tirar o coelho');
    expect(edit.announcement).toBe(`Vou fazer o que você pediu. ${NOTICE}`);
    expect(edit.version.metrics.notice).toBe(true);
  });

  it('Parar na primeira edição: o aviso já foi mostrado e não se repete no pedido seguinte', async () => {
    const { scene } = await h.readyScene();
    const first = await step(scene.id, 'tira o coelho', 'pedido_item', 'tirar o coelho');
    expect(first.announcement).toContain(NOTICE);
    await stop(scene.id, first.sent.versionId);

    const second = await step(scene.id, 'deixa mais quente', 'pedido_ajuste_geral', 'mais quente');
    expect(second.announcement).toBe('Vou fazer o que você pediu.');
    expect(second.version.metrics.notice).toBeUndefined();
  });

  it('Imagem nova não conta como edição: o anúncio dela não traz o aviso, e o do segundo pedido traz', async () => {
    const { scene } = await h.readyScene();
    const fresh = await step(scene.id, 'gere outra imagem', 'imagem_nova', 'outra imagem');
    expect(fresh.announcement).toBe('Vou fazer o que você pediu.');
    expect(fresh.version.metrics.notice).toBeUndefined();
    await stop(scene.id, fresh.sent.versionId);

    const second = await step(scene.id, 'deixa mais quente', 'pedido_ajuste_geral', 'mais quente');
    expect(second.announcement).toBe(`Vou fazer o que você pediu. ${NOTICE}`);
  });

  it('Edições seguintes: o aviso não se repete, mesmo em outra sessão', async () => {
    const { scene } = await h.readyScene();
    const first = await step(scene.id, 'tira o coelho', 'pedido_item', 'tirar o coelho');
    await stop(scene.id, first.sent.versionId);
    const second = await step(scene.id, 'mais flores', 'pedido_item', 'mais flores');
    expect(second.announcement).not.toContain('redesenha');
    await stop(scene.id, second.sent.versionId);
    const third = await step(scene.id, 'menos ovos', 'pedido_item', 'menos ovos');
    expect(third.announcement).not.toContain('redesenha');
  });

  it('o aviso fica fora do limite de 260 caracteres do reply e não passa pela validação de frases proibidas', async () => {
    const { scene } = await h.readyScene();
    const sent = await h.post(scene.id, 'tira o coelho');
    const reply = `Vou tirar o coelho da direita do rodapé. ${'x'.repeat(200)}`.slice(0, 255);
    const { client } = h.directorClient(async () =>
      directorAnswer(
        directorPlan({
          turn_kind: 'pedido_item',
          will_change_image: true,
          reply,
          what_to_change: 'tirar o coelho',
          requests: [{ id: null, text: 'tirar o coelho', action: 'open', quote: null }],
        }),
      ),
    );
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });
    const announcement = await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
      versionId: sent.versionId,
      role: 'assistant',
    });
    expect(announcement.content).toBe(`${reply} ${NOTICE}`);
    expect(announcement.content.length).toBeGreaterThan(260);
    // o aviso fala em "voltar" e em "redesenha", que a validação de frases não conhece nem barra
    expect((await h.versionOf(sent.versionId)).status).toBe('queued');
  });
});
