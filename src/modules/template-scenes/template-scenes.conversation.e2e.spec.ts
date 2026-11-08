import * as sharp from 'sharp';
import { useE2eHarness } from './testing/scene-e2e-harness';
import { describeIfSceneDb } from './testing/scene-test-db';

/**
 * E2E da conversa da cena (change add-template-scene-conversation): controller, services, consumers do Diretor e da
 * imagem REAIS, pg-boss real e `chroma_x_e2e`, com o provedor de imagem, o Diretor e o juiz simulados (sem rede e sem
 * custo). Fluxo base: gerar, pedir, marcar, Parar, voltar, recusa, camada e falha do Diretor, mais o acesso negado da
 * rota nova. A janela dura 1 s nos testes. Rodar com `TEMPLATE_SCENE_E2E_DB_URL=... npm run test --
 * template-scenes.conversation.e2e --runInBand`.
 */
describeIfSceneDb('Conversa da cena de template (e2e, banco chroma_x_e2e)', () => {
  jest.setTimeout(120_000);
  const h = useE2eHarness();
  const { http, authed, get, post, newScene, waitForScene, isReady } = h;

  type Scene = Record<string, any>;
  const message = (id: string, content: string, revision: number, extra: object = {}) =>
    post(`/${id}/messages`, { content, expectedRevision: revision, ...extra });
  const idle = (scene: Scene) => scene.activeVersion === null;

  /** Cena com a primeira imagem pronta (versão 1). */
  async function sceneWithImage(name: string) {
    const created = await newScene(name);
    const sent = await message(created.id, 'campo verde com sol à direita', 0);
    expect(sent.status).toBe(202);
    const ready = await waitForScene(created.id, isReady);
    return { id: created.id, ready };
  }

  it('gerar e pedir: o POST responde 202 na hora, o Diretor anuncia, a janela passa, a imagem sai e o juiz confere', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa pedir');
    expect(ready.currentVersion).toMatchObject({
      operation: 'generate',
      displayNumber: 1,
      judge: 'sim',
    });

    const sent = await message(id, 'tira o coelho da direita do rodapé', ready.revision);
    expect(sent.status).toBe(202);
    expect(sent.body.data).toEqual({
      messageId: expect.any(String),
      versionId: expect.any(String),
      jobId: expect.any(String),
      revision: ready.revision + 1,
    });

    const reading = await get(`/${id}`);
    expect(reading.body.data.activeVersion).toMatchObject({ status: 'queued', step: 'reading' });

    const windowed = await waitForScene(id, (s) => s.activeVersion?.windowEndsAt != null);
    expect(windowed.activeVersion).toMatchObject({
      status: 'queued',
      step: null,
      displayNumber: null,
    });
    const lastAnnouncement = windowed.messages.at(-1);
    expect(lastAnnouncement.role).toBe('assistant');
    expect(lastAnnouncement.content).toContain('Cada pedido redesenha a imagem inteira');

    const done = await waitForScene(id, (s) => s.currentVersion?.number === 2 && idle(s));
    expect(done.currentVersion).toMatchObject({
      operation: 'redraw',
      displayNumber: 2,
      judge: 'sim',
    });
    expect(done.messages.at(-1).content).toMatch(/^Conferi a imagem nova: /);
    expect(done.versions.items.map((v: Scene) => v.displayNumber)).toEqual([2, 1]);
  });

  it('marcar: o pedido com retângulo não espera a janela e leva a marcação gravada', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa marcar');
    const sent = await message(id, 'tira esse coelho', ready.revision, {
      region: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 },
    });
    expect(sent.status).toBe(202);

    const done = await waitForScene(id, (s) => s.currentVersion?.number === 2 && idle(s));
    expect(done.currentVersion).toMatchObject({
      operation: 'redraw',
      requestedRegion: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 },
      windowEndsAt: null,
    });
  });

  it('placa com frase na área marcada: uma imagem com markup, sem janela, e o texto conferido letra por letra', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa placa');
    const sent = await message(
      id,
      'coloca uma placa de madeira com a frase "Promoção de Páscoa" #plano-texto',
      ready.revision,
      { region: { x: 0.1, y: 0.88, w: 0.5, h: 0.08 } },
    );
    expect(sent.status).toBe(202);
    const done = await waitForScene(id, (s) => s.currentVersion?.number === 2 && idle(s));
    expect(done.currentVersion).toMatchObject({
      operation: 'redraw',
      windowEndsAt: null,
      judge: 'sim',
    });
    expect(done.messages.at(-1).content).toContain(
      'Conferi o texto letra por letra: “Promoção de Páscoa”.',
    );
    expect(done.messages.at(-1).content).not.toMatch(/N[ãa]o\spinto/);
  });

  it('refação do texto: o juiz lê errado na primeira imagem, a segunda acerta, e uma só versão nasce', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa refação');
    await message(
      id,
      'coloca uma placa com a frase "Promoção de Páscoa" no rodapé #plano-texto #juiz-texto-errado',
      ready.revision,
    );
    const done = await waitForScene(id, (s) => s.currentVersion?.number === 2 && idle(s), 60_000);
    expect(done.currentVersion).toMatchObject({ displayNumber: 2, judge: 'sim' });
    expect(done.messages.at(-1).content).toContain('Conferi o texto letra por letra');
    expect(done.messages.at(-1).content).not.toContain('saiu diferente');
    expect(done.versions.items.map((v: Scene) => v.displayNumber)).toEqual([2, 1]);
  });

  it('refação que não resolve: a segunda imagem vale, judge parcial, e o chat diz o que pediu e o que leu', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa refação 2');
    await message(
      id,
      'coloca uma placa com a frase "Promoção de Páscoa" no rodapé #plano-texto #juiz-texto-errado-2',
      ready.revision,
    );
    const done = await waitForScene(id, (s) => s.currentVersion?.number === 2 && idle(s), 60_000);
    expect(done.currentVersion).toMatchObject({ judge: 'parcial' });
    expect(done.messages.at(-1).content).toContain(
      'Pedi “Promoção de Páscoa” e li “Promocao de Pascoa”.',
    );
  });

  it('Parar: dentro da janela a versão é cancelada, nenhuma imagem sai e a atual não muda', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa parar');
    const sent = await message(id, 'deixa tudo mais quente', ready.revision);
    const windowed = await waitForScene(id, (s) => s.activeVersion?.windowEndsAt != null);

    const cancel = await post(`/${id}/versions/${sent.body.data.versionId}/cancel`);
    expect(cancel.status).toBe(202);
    expect(cancel.body.data.status).toBe('cancelled');

    const done = await waitForScene(id, idle);
    expect(done.currentVersion.id).toBe(ready.currentVersion.id);
    expect(done.messages.at(-1).content).toBe('Geração cancelada.');
    expect(windowed.currentVersion.id).toBe(ready.currentVersion.id);
    const again = await message(id, 'agora sim', done.revision);
    expect(again.status).toBe(202);
  });

  it('voltar: "volta como estava antes" restaura a versão anterior sem chamar a imagem', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa voltar');
    await message(id, 'tira o coelho', ready.revision, {
      region: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 },
    });
    const second = await waitForScene(id, (s) => s.currentVersion?.number === 2 && idle(s));

    await message(id, 'volta como estava antes', second.revision);
    const back = await waitForScene(id, (s) => s.currentVersion?.number === 3 && idle(s));
    expect(back.currentVersion).toMatchObject({
      operation: 'restore',
      displayNumber: 3,
      parentVersionId: ready.currentVersion.id,
    });
    expect(back.currentVersion.master.id).toBe(ready.currentVersion.master.id);
    expect(back.messages.at(-1).content).toBe(
      'Voltei para a imagem da versão 1. Ela agora é a versão 3.',
    );
  });

  it('logo: pedir a logo pintada é recusado, com a camada como saída, sem imagem nova', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa logo');
    await message(id, 'integra a logo na imagem', ready.revision);
    const done = await waitForScene(id, (s) => s.revision > ready.revision + 1 && idle(s));
    expect(done.currentVersion.id).toBe(ready.currentVersion.id);
    expect(done.messages.at(-1).content).toContain('A logo fica sempre como camada');
  });

  it('camada: logo anexada e texto exato aparecem sem janela e sem imagem nova', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa camada');
    const png = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#f00' } })
      .png()
      .toBuffer();
    const logo = await authed(http().post(`/v1/template-scenes/${id}/assets/logo`)).attach(
      'file',
      png,
      {
        filename: 'logo.png',
        contentType: 'image/png',
      },
    );
    expect(logo.status).toBe(201);
    const fresh = await get(`/${id}`);

    await message(
      id,
      'coloca a logo à esquerda no cabeçalho e escreve "Ofertas da semana" embaixo dela, como texto editável',
      fresh.body.data.revision,
      { attachments: [{ assetId: logo.body.data.assetId }] },
    );
    const done = await waitForScene(
      id,
      (s) => s.currentVersion?.operation === 'set_layer' && idle(s),
    );
    expect(done.currentVersion.elements.map((e: Scene) => e.kind)).toEqual(['logo', 'text']);
    expect(done.currentVersion.master.id).toBe(ready.currentVersion.master.id);
    expect(done.currentVersion.providerCostUsd).toBe(0);
  });

  it('falha do Diretor: a mensagem fica, a versão falha com DIRECTOR_UNAVAILABLE e a cena fica livre', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa falha');
    const sent = await message(id, 'tira o coelho #diretor-falha', ready.revision);
    expect(sent.status).toBe(202); // um 409 de revisão ou de cena ocupada aparece aqui, e não como espera de 30 s
    const done = await waitForScene(id, (s) => s.revision > ready.revision + 1 && idle(s));
    expect(done.currentVersion.id).toBe(ready.currentVersion.id);
    expect(done.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Não consegui ler seu pedido agora. Nada foi alterado.',
    });
    const next = await message(id, 'agora tira o coelho', done.revision);
    expect(next.status).toBe(202);
  });

  it('camada sem mudança (cena 9cb42bb7, versão 9): mover a logo para onde ela já está não cria versão e diz que nada mudou', async () => {
    const { id, ready } = await sceneWithImage('E2E conversa camada igual');
    const png = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#f00' } })
      .png()
      .toBuffer();
    const logo = await authed(http().post(`/v1/template-scenes/${id}/assets/logo`)).attach(
      'file',
      png,
      { filename: 'logo.png', contentType: 'image/png' },
    );
    const fresh = await get(`/${id}`);
    await message(id, 'coloca a logo à esquerda no cabeçalho', fresh.body.data.revision, {
      attachments: [{ assetId: logo.body.data.assetId }],
    });
    const placed = await waitForScene(
      id,
      (s) => s.currentVersion?.operation === 'set_layer' && idle(s),
    );
    await message(id, 'passa a logo para a esquerda', placed.revision);
    const done = await waitForScene(id, (s) => s.revision > placed.revision + 1 && idle(s));
    expect(done.currentVersion.id).toBe(placed.currentVersion.id);
    expect(done.messages.at(-1).content).toContain('nada mudou');
    expect(done.messages.at(-1).content).not.toContain('Alterado apenas');
    expect(ready.currentVersion.master.id).toBe(done.currentVersion.master.id);
  });

  describe('histórico e acesso negado da rota nova', () => {
    it('GET messages com cursor traz as anteriores, em páginas', async () => {
      const { id } = await sceneWithImage('E2E conversa histórico');
      const detail = await get(`/${id}`);
      const first = detail.body.data.messages[0];
      const page = await get(`/${id}/messages?limit=1`);
      expect(page.status).toBe(200);
      expect(page.body.data.items).toHaveLength(1);
      expect(page.body.data.hasMore).toBe(true);
      const older = await get(`/${id}/messages?before=${detail.body.data.messages[2].id}&limit=50`);
      expect(older.body.data.items.map((m: Scene) => m.id)).toEqual([
        first.id,
        detail.body.data.messages[1].id,
      ]);
      expect(older.body.data.hasMore).toBe(false);
      expect((await get(`/${id}/messages?before=abc`)).status).toBe(400);
      expect((await get(`/00000000-0000-4000-8000-000000000000/messages`)).status).toBe(404);
    });

    it('Sem login: GET messages responde 401', async () => {
      const created = await newScene('E2E conversa sem login');
      expect((await http().get(`/v1/template-scenes/${created.id}/messages`)).status).toBe(401);
      const bad = await http()
        .get(`/v1/template-scenes/${created.id}/messages`)
        .set('Authorization', 'Bearer lixo');
      expect(bad.status).toBe(401);
    });
  });
});
