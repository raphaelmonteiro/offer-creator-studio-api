import { SceneVisionClient } from '../providers/scene-vision-client';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { insertMessage } from '../testing/scene-fixtures';
import { directorPlan } from '../testing/scene-director-fixtures';
import { describeIfSceneDb } from '../testing/scene-test-db';

const judge = (body: Record<string, unknown>) =>
  ({
    compare: jest.fn().mockResolvedValue({
      text: JSON.stringify({
        atendeu: 'sim',
        mudou: 'O coelho saiu.',
        vistos: [],
        nao_vistos: [],
        faltou: '',
        texto_lido: [],
        texto_extra: '',
        emenda: false,
        emenda_descricao: '',
        ...body,
      }),
      usage: { prompt_tokens: 3000, completion_tokens: 200 },
      requestId: 'req_judge',
      latencyMs: 500,
    }),
  }) as SceneVisionClient;

const item = (id: string, text: string, sourceMessageId: string) => ({
  id,
  text,
  status: 'open' as const,
  sourceMessageId,
  updatedAt: new Date().toISOString(),
});

describeIfSceneDb('Uma mudança por rodada (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useDirectorHarness();

  it('Duas mudanças na mesma mensagem: o prompt traz só a remoção, e a resposta pergunta se faz a placa agora', async () => {
    const { scene } = await h.readyScene();
    const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
      plan: directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: 'Remove the bunny',
      }),
      request: 'tira o coelho e coloca uma placa com "Oferta"',
    });
    const message = (await h.messagesOf(scene.id)).find((m) => m.versionId === queued.id);
    await h.dataSource.manager.update(
      TemplateScene,
      { id: scene.id },
      { brief: [item('p1', 'placa com “Oferta”', message!.id)] },
    );
    const { provider, edit } = h.fakeProvider(() => h.okResult(0.1));
    await h
      .processorWith(provider, undefined, judge({ nao_vistos: ['p1'] }))
      .process(h.job(scene.id, queued.id));

    const replies = await h.dataSource.manager.find(TemplateSceneMessage, {
      where: { versionId: queued.id, role: 'assistant' },
    });
    expect(edit.mock.calls[0][0].prompt).toContain('Make exactly one change: Remove the bunny.');
    expect(edit.mock.calls[0][0].prompt).not.toContain('em aberto');
    expect(replies[0].content).toMatch(
      /Ainda falta: placa com “Oferta”\. Quer que eu faça agora\?$/,
    );
    expect((await h.sceneOf(scene.id)).brief[0].status).toBe('open');
  });

  it('Item feito não é oferecido: com o juiz em "sim" e sem ids, a resposta não pergunta se faz agora (R68)', async () => {
    const { scene } = await h.readyScene();
    const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
      plan: directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: 'Add a wooden sign near the bottom',
      }),
      request: 'coloca uma placa de madeira no rodapé',
    });
    const message = (await h.messagesOf(scene.id)).find((m) => m.versionId === queued.id);
    await h.dataSource.manager.update(
      TemplateScene,
      { id: scene.id },
      { brief: [item('p1', 'placa de madeira no rodapé', message!.id)] },
    );
    const { provider } = h.fakeProvider(() => h.okResult(0.1));
    await h
      .processorWith(provider, undefined, judge({ vistos: [], nao_vistos: [] }))
      .process(h.job(scene.id, queued.id));
    const replies = await h.dataSource.manager.find(TemplateSceneMessage, {
      where: { versionId: queued.id, role: 'assistant' },
    });
    expect(replies[0].content).not.toContain('Quer que eu faça agora?');
    expect(replies[0].content).not.toContain('Ainda falta');
  });

  it('o item oferecido é o que o juiz pôs em nao_vistos, e não o primeiro aberto da mensagem (R68)', async () => {
    const { scene } = await h.readyScene();
    const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
      plan: directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: 'Remove the bunny',
      }),
      request: 'tira o coelho, coloca um rio e uma ponte',
    });
    const message = (await h.messagesOf(scene.id)).find((m) => m.versionId === queued.id);
    await h.dataSource.manager.update(
      TemplateScene,
      { id: scene.id },
      {
        brief: [
          item('p1', 'coelho fora', message!.id),
          item('p2', 'um rio', message!.id),
          item('p3', 'uma ponte', message!.id),
        ],
      },
    );
    const { provider } = h.fakeProvider(() => h.okResult(0.1));
    await h
      .processorWith(provider, undefined, judge({ vistos: ['p1'], nao_vistos: ['p3'] }))
      .process(h.job(scene.id, queued.id));
    const replies = await h.dataSource.manager.find(TemplateSceneMessage, {
      where: { versionId: queued.id, role: 'assistant' },
    });
    expect(replies[0].content).toMatch(/Ainda falta: uma ponte\. Quer que eu faça agora\?$/);
  });

  it('Item aberto de outra mensagem não vira pergunta de agora', async () => {
    const { scene } = await h.readyScene();
    await h.dataSource.manager.update(
      TemplateScene,
      { id: scene.id },
      { brief: [item('p1', 'um rio no meio', 'outra-mensagem')] },
    );
    const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
      plan: directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: 'Remove the bunny',
      }),
      request: 'tira o coelho',
    });
    const { provider } = h.fakeProvider(() => h.okResult(0.1));
    await h
      .processorWith(provider, undefined, judge({ nao_vistos: ['p1'] }))
      .process(h.job(scene.id, queued.id));
    const replies = await h.dataSource.manager.find(TemplateSceneMessage, {
      where: { versionId: queued.id, role: 'assistant' },
    });
    expect(replies[0].content).not.toContain('Quer que eu faça agora?');
    expect(replies[0].content).toContain('Ainda falta parte do que você pediu.');
  });

  it('"Continua" executa o que falta: o plano da rodada é a placa, com "Oferta" no bloco de texto exato', async () => {
    const { scene } = await h.readyScene();
    const earlier = await insertMessage(h.dataSource, scene.id, {
      content: 'tira o coelho e coloca uma placa com "Oferta"',
      role: 'user',
    });
    await h.dataSource.manager.update(
      TemplateScene,
      { id: scene.id },
      { brief: [item('p1', 'placa com “Oferta”', earlier.id)] },
    );
    const sent = await h.post(scene.id, 'sim, faz');
    const { client, plan } = h.directorClient(async () =>
      directorAnswer({
        turn_kind: 'pedido_item',
        will_change_image: true,
        reply: 'Vou colocar a placa com a frase “Oferta”.',
        what_to_change: 'Add a modest sign',
        exact_text: ['Oferta'],
        requests: [{ id: 'p1', text: 'placa com “Oferta”', action: 'open', quote: null }],
      }),
    );
    await h
      .directorProcessor(client)
      .process({ sceneId: scene.id, versionId: sent.versionId }, 'job-d');
    const version = await h.versionOf(sent.versionId);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(version.status).toBe('queued');
    expect((version.metrics.plan as { image: { exact_text: string[] } }).image.exact_text).toEqual([
      'Oferta',
    ]);
  });
});
