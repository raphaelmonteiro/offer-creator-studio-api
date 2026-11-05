import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { Raster } from '../../shared/image/raster';
import { loadRgb } from '../../shared/image/rgb';
import { authorizedRegion, marginPx, rasterizeRegion } from './domain/scene-shapes';
import { MaskShape, Rect } from './domain/scene.types';
import { useE2eHarness } from './testing/scene-e2e-harness';
import { describeIfSceneDb } from './testing/scene-test-db';

/**
 * E2E da edição local (estágio 4): controller, services e processor reais, pg-boss real no banco
 * `chroma_x_e2e` e o provedor `mock` (a edição pinta de verdade a área da máscara). Base do fluxo, sem
 * casos de borda (esses ficam nos testes unitários). Rodar com
 * `TEMPLATE_SCENE_E2E_DB_URL=... npm run test -- template-scenes.local-edit.e2e --runInBand`.
 */
describeIfSceneDb('Cena de template: edição local (e2e, banco chroma_x_e2e)', () => {
  const h = useE2eHarness();
  const { http, post, get, newScene, waitForScene } = h;

  const RECT: Rect = { x: 0.55, y: 0.05, w: 0.3, h: 0.08 };
  const LASSO: MaskShape = {
    kind: 'lasso',
    points: [
      { x: 0.2, y: 0.5 },
      { x: 0.45, y: 0.5 },
      { x: 0.33, y: 0.58 },
    ],
  };

  /** Cena de 1920x3840 já gerada (versão 1 pronta). */
  async function generatedScene(name: string) {
    const created = await newScene(name);
    const sent = await post(`/${created.id}/messages`, {
      content: 'campo verde com sol',
      expectedRevision: 0,
    });
    expect(sent.status).toBe(202);
    return waitForScene(
      created.id,
      (s) => s.currentVersion?.number === 1 && s.activeVersion === null,
    );
  }

  /** Espera a versão `number` ficar atual e a cena ociosa. */
  const waitForVersion = (sceneId: string, number: number) =>
    waitForScene(sceneId, (s) => s.currentVersion?.number === number && s.activeVersion === null);

  const pixelsOf = async (url: string) =>
    loadRgb(await fs.readFile(path.join(h.uploadsDir, url.replace(/^\/uploads\//, ''))));

  /** Diferenças fora da região autorizada (forma dilatada pela margem de 4%). */
  async function differencesOutside(
    before: string,
    after: string,
    region: Rect | MaskShape,
  ): Promise<number> {
    const [a, b] = await Promise.all([pixelsOf(before), pixelsOf(after)]);
    const shape = await rasterizeRegion(
      'kind' in region ? region : { kind: 'rect', rect: region },
      a.width,
      a.height,
    );
    const authorized: Raster = authorizedRegion(shape, marginPx(0.04, a.width, a.height));
    let different = 0;
    for (let i = 0; i < authorized.data.length; i += 1) {
      if (authorized.data[i]) continue;
      for (let c = 0; c < 3; c += 1) if (a.data[i * 3 + c] !== b.data[i * 3 + c]) different += 1;
    }
    return different;
  }

  it('retângulo: versão 2 pronta, exterior idêntico, e a versão grava a região, as métricas e o custo', async () => {
    const first = await generatedScene('E2E Edição retângulo');

    const sent = await post(`/${first.id}/messages`, {
      content: 'deixa o sol mais alaranjado',
      expectedRevision: first.revision,
      region: RECT,
    });
    expect(sent.status).toBe(202);
    expect(sent.body.data).toMatchObject({ operation: 'local_edit' });
    expect(sent.body.data.jobId).toEqual(expect.any(String));

    const second = await waitForVersion(first.id, 2);
    expect(second.currentVersion).toMatchObject({
      operation: 'local_edit',
      status: 'ready',
      requestedRegion: RECT,
    });
    expect(second.currentVersion.metrics.insideMaskDiffRatio).toBeGreaterThan(0.9);
    expect(second.currentVersion.metrics.noChange).toBe(false);
    expect(second.currentVersion.metrics).toHaveProperty('marginDiffRatio');
    expect(second.currentVersion.metrics).toHaveProperty('seamSsim');
    expect(second.totalCostUsd).toBe(first.totalCostUsd);
    expect(
      await differencesOutside(
        first.currentVersion.master.url,
        second.currentVersion.master.url,
        RECT,
      ),
    ).toBe(0);
    expect(second.messages.at(-1).content).toContain('Alterei a área marcada');
  });

  it('laço: o que está fora da forma e da margem fica idêntico', async () => {
    const first = await generatedScene('E2E Edição laço');

    const sent = await post(`/${first.id}/messages`, {
      content: 'deixa o sol mais brilhante',
      expectedRevision: first.revision,
      mask: LASSO,
    });
    expect(sent.status).toBe(202);

    const second = await waitForVersion(first.id, 2);
    expect(second.currentVersion.requestedMask).toEqual(LASSO);
    expect(
      await differencesOutside(
        first.currentVersion.master.url,
        second.currentVersion.master.url,
        LASSO,
      ),
    ).toBe(0);
  });

  it('item sem área e "mover o sol": respondem na hora, sem job e sem custo', async () => {
    const first = await generatedScene('E2E Sem job');

    const needsRegion = await post(`/${first.id}/messages`, {
      content: 'coloca um brilho no sol',
      expectedRevision: first.revision,
    });
    expect(needsRegion.status).toBe(202);
    expect(needsRegion.body.data).toMatchObject({ jobId: null, operation: 'needs_region' });
    expect(needsRegion.body.data.assistantMessage.content).toContain('Marque a área');

    const move = await post(`/${first.id}/messages`, {
      content: 'troca o sol de lado',
      expectedRevision: needsRegion.body.data.revision,
    });
    expect(move.body.data).toMatchObject({ jobId: null, operation: 'move_unavailable' });
    expect(move.body.data.assistantMessage.content).toContain('sem refazê-lo');

    const after = (await get(`/${first.id}`)).body.data;
    expect(after.activeVersion).toBeNull();
    expect(after.currentVersion.number).toBe(1);
    expect(after.totalCostUsd).toBe(first.totalCostUsd);
    expect(after.versions.items.slice(0, 2).map((v: { status: string }) => v.status)).toEqual([
      'rejected',
      'rejected',
    ]);
  });

  it('ajuste geral: pergunta, só depois de confirmar cria a versão com o fundo novo, e as camadas ficam', async () => {
    const first = await generatedScene('E2E Ajuste geral');

    const asked = await post(`/${first.id}/messages`, {
      content: 'deixa tudo mais quente',
      expectedRevision: first.revision,
    });
    expect(asked.body.data).toMatchObject({ jobId: null, operation: 'needs_confirmation_global' });

    const confirmed = await post(`/${first.id}/messages`, {
      content: 'Confirmar',
      expectedRevision: asked.body.data.revision,
      confirmGlobal: true,
      replyToMessageId: asked.body.data.assistantMessage.id,
    });
    expect(confirmed.status).toBe(202);
    expect(confirmed.body.data.jobId).toEqual(expect.any(String));

    const done = await waitForVersion(first.id, 3);
    expect(done.currentVersion.status).toBe('ready');
    expect(done.currentVersion.master.id).not.toBe(first.currentVersion.master.id);
    expect(done.currentVersion.elements).toEqual(first.currentVersion.elements);
    expect(done.messages.at(-1).content).toContain('Logo e texto não mudaram');
  });

  it('adicionar: cria um elemento generated com PNG transparente na área marcada; o fundo não muda', async () => {
    const first = await generatedScene('E2E Adicionar');

    const sent = await post(`/${first.id}/messages`, {
      content: 'adiciona um balão de ar quente',
      expectedRevision: first.revision,
      region: { x: 0.1, y: 0.06, w: 0.3, h: 0.08 },
    });
    expect(sent.body.data.operation).toBe('add_element');

    const done = await waitForVersion(first.id, 2);
    const element = done.currentVersion.elements.find(
      (e: { kind: string }) => e.kind === 'generated',
    );
    expect(element).toMatchObject({ name: 'Balão de ar quente' });
    expect(done.currentVersion.master.id).toBe(first.currentVersion.master.id);
    const asset = done.currentVersion.assets.find((a: { id: string }) => a.id === element.assetId);
    expect(asset).toMatchObject({ role: 'element' });
    const meta = await sharp(
      path.join(h.uploadsDir, asset.url.replace(/^\/uploads\//, '')),
    ).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it('logo e texto pelo chat: viram camadas, sem chamar o modelo e sem custo', async () => {
    const first = await generatedScene('E2E Logo e texto');
    const png = await sharp({ create: { width: 60, height: 30, channels: 4, background: '#e11' } })
      .png()
      .toBuffer();
    const upload = await h
      .authed(http().post(`/v1/template-scenes/${first.id}/assets/logo`))
      .attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);

    const sent = await post(`/${first.id}/messages`, {
      content: 'coloca a logo à esquerda no cabeçalho e escreve "Ofertas da semana" embaixo dela',
      expectedRevision: first.revision,
      attachments: [{ assetId: upload.body.data.assetId }],
    });
    expect(sent.body.data).toMatchObject({ operation: 'set_layer' });

    const done = await waitForVersion(first.id, 2);
    expect(done.currentVersion.operation).toBe('set_layer');
    expect(done.currentVersion.master.id).toBe(first.currentVersion.master.id);
    expect(done.currentVersion.elements.map((e: { kind: string }) => e.kind)).toEqual([
      'logo',
      'text',
    ]);
    expect(done.currentVersion.elements[1].text).toBe('Ofertas da semana');
    expect(done.totalCostUsd).toBe(first.totalCostUsd);
  });

  it('alvo duplo (região e elemento): 400 e nada é gravado; sem token: 401', async () => {
    const first = await generatedScene('E2E Alvo duplo');

    const both = await post(`/${first.id}/messages`, {
      content: 'deixa o sol laranja',
      expectedRevision: first.revision,
      region: RECT,
      targetElementId: 'logo-1',
    });
    expect(both.status).toBe(400);
    const unchanged = (await get(`/${first.id}`)).body.data;
    expect(unchanged.revision).toBe(first.revision);
    expect(unchanged.versions.total).toBe(1);

    const denied = await http()
      .post(`/v1/template-scenes/${first.id}/messages`)
      .send({ content: 'x', expectedRevision: first.revision, region: RECT });
    expect(denied.status).toBe(401);
  });
});
