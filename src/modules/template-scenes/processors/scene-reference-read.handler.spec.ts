import { FICHA_NAVARRO, FICHA_R1 } from '../testing/reference-fichas';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { conceptVision, useReferenceHarness } from '../testing/scene-reference-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { errorOf } from '../testing/scene-test-helpers';

describeIfSceneDb('Leitura do encarte em ficha-conceito (banco chroma_x_e2e)', () => {
  const h = useReferenceHarness();

  async function lastReply(sceneId: string): Promise<string> {
    const rows = await h.dataSource.manager.find(TemplateSceneMessage, {
      where: { sceneId, role: 'assistant' },
      order: { createdAt: 'DESC' },
    });
    return rows[0].content;
  }

  it('ficha mostrada antes de gastar: rejected, proposed, resumo em pt-BR, custo da visão e nenhuma imagem', async () => {
    const scene = await h.newScene();
    const sent = await h.upload(scene.id);
    const vision = conceptVision(() => ({
      ...FICHA_R1,
      is_retail_flyer: true,
      theme_pt: 'festa junina',
      signature_elements: [
        {
          element: 'Triangular paper bunting',
          label_pt: 'bandeirinhas de São João',
          kind: 'decoration',
          where: 'header',
          notes: 'pennants',
        },
      ],
    }));
    const fake = await h.run(scene.id, sent.versionId, { vision: vision.client });

    const version = await h.versionOf(sent.versionId);
    expect(version.status).toBe('rejected');
    expect(version.providerCostUsd).toBeCloseTo(0.00084, 5);
    const read = await h.referenceState(sent.versionId);
    expect(read).toMatchObject({ state: 'proposed', model: 'gpt-6-luna' });
    expect(read?.raw).toBeDefined();
    expect(read?.concept?.elements).toHaveLength(1);
    expect(read?.prompt).toContain('You are an art director analysing a retail flyer');
    expect(await lastReply(scene.id)).toMatch(
      /^Vou usar: bandeirinhas de São João no topo; tema festa junina; cores: .*; corpo liso em .*\. Deixo de fora: logo, textos, preços e produtos, as seções de produto\. Posso gerar assim\? Se quiser mudar algo, use "Corrigir"\.$/,
    );
    expect(fake.generate).not.toHaveBeenCalled();
    expect(fake.edit).not.toHaveBeenCalled();
    expect((await h.sceneOf(scene.id)).totalCostUsd).toBeCloseTo(0.00084, 5);
    // O encarte vai à visão como única imagem (só `after`).
    const input = vision.compare.mock.calls[0][0];
    expect(input.before).toBeUndefined();
    expect(input.after.length).toBeGreaterThan(0);
  });

  it('visão do mock: a ficha fixa passa pelo sanitizador (o medalhão do carrinho sai e o resumo diz)', async () => {
    const scene = await h.newScene();
    const sent = await h.proposed(scene);
    const read = await h.referenceState(sent.versionId);
    expect(read?.removed).toContainEqual(
      expect.objectContaining({ text: 'Circular shopping-cart medallion', reason: 'logo_badge' }),
    );
    expect(read?.summary?.leftOut).toContain('o selo/medalhão da logo');
    expect(await lastReply(scene.id)).toContain('o selo/medalhão da logo');
  });

  it('Navarro: sem o medalhão (D-1); ficam o bokeh e a faixa de baixo', async () => {
    const scene = await h.newScene();
    const sent = await h.upload(scene.id);
    await h.run(scene.id, sent.versionId, { vision: conceptVision(() => FICHA_NAVARRO).client });
    const read = await h.referenceState(sent.versionId);
    expect(read?.concept?.elements.map((e) => e.where)).toEqual(['header', 'bottom edge']);
  });

  it('imagem que não é encarte: failed, resposta fixa e custo registrado', async () => {
    const scene = await h.newScene();
    const sent = await h.upload(scene.id);
    await h.run(scene.id, sent.versionId, {
      vision: conceptVision(() => ({ is_retail_flyer: false })).client,
    });
    expect((await h.versionOf(sent.versionId)).status).toBe('rejected');
    expect((await h.referenceState(sent.versionId))?.state).toBe('failed');
    expect(await lastReply(scene.id)).toBe('Não reconheci um encarte nessa imagem. Envie outra.');
    expect((await h.versionOf(sent.versionId)).providerCostUsd).toBeGreaterThan(0);
  });

  it.each([
    [
      'JSON sem signature_elements nem palette',
      () => ({ is_retail_flyer: true, theme: 'x' }),
      true,
    ],
    ['texto que não é JSON', () => 'isto não é json', true],
    ['visão fora do ar', () => Promise.reject(new Error('fora do ar')), false],
  ])('%s: failed com REFERENCE_READ_FAILED', async (_name, reply, costKnown) => {
    const scene = await h.newScene();
    const sent = await h.upload(scene.id);
    await h.run(scene.id, sent.versionId, { vision: conceptVision(reply).client });

    const version = await h.versionOf(sent.versionId);
    expect(version).toMatchObject({ status: 'failed', errorCode: 'REFERENCE_READ_FAILED' });
    expect((await h.referenceState(sent.versionId))?.state).toBe('failed');
    expect(await lastReply(scene.id)).toBe('Não consegui ler o encarte. Tente enviar de novo.');
    if (costKnown) expect(version.providerCostUsd).toBeGreaterThan(0);
  });

  it('job repetido: sai sem chamar a visão', async () => {
    const scene = await h.newScene();
    const sent = await h.upload(scene.id);
    const vision = conceptVision(() => FICHA_R1);
    await h.run(scene.id, sent.versionId, { vision: vision.client });
    await h.run(scene.id, sent.versionId, { vision: vision.client });
    expect(vision.compare).toHaveBeenCalledTimes(1);
  });

  it('nenhum elemento sobra: o resumo diz que usa o tema e as cores e o "Gerar assim" continua valendo', async () => {
    const scene = await h.newScene();
    const sent = await h.upload(scene.id);
    await h.run(scene.id, sent.versionId, {
      vision: conceptVision(() => ({
        is_retail_flyer: true,
        theme: 'October sale',
        theme_pt: 'ofertas de outubro',
        signature_elements: [
          { element: 'seal', kind: 'decoration', where: 'header', notes: '' },
          { element: 'shopping cart', kind: 'decoration', where: 'corners', notes: '' },
        ],
        palette: [{ hex: '#112233', name_pt: 'azul', role: 'header' }],
      })).client,
    });
    expect(await lastReply(scene.id)).toContain(
      'Sem enfeites marcantes: vou usar o tema e as cores.',
    );
    const revision = await h.revisionOf(scene.id);
    await expect(h.generate(scene.id, revision)).resolves.toMatchObject({
      versionId: expect.any(String),
    });
  });

  it('parar antes da leitura: cancelada, sem chamada de visão, ficha failed', async () => {
    const scene = await h.newScene();
    const sent = await h.upload(scene.id);
    await h.dataSource.manager.update(
      'template_scene_versions',
      { id: sent.versionId },
      { cancelRequestedAt: new Date() },
    );
    const vision = conceptVision(() => FICHA_R1);
    await h.run(scene.id, sent.versionId, { vision: vision.client });
    expect((await h.versionOf(sent.versionId)).status).toBe('cancelled');
    expect(vision.compare).not.toHaveBeenCalled();
    expect((await h.referenceState(sent.versionId))?.state).toBe('failed');
  });

  it('a leitura não aparece como versão com imagem e a cena segue sem imagem', async () => {
    const scene = await h.newScene();
    await h.proposed(scene);
    const rows = await h.versions(scene.id);
    expect(rows.every((v) => v.masterAssetId === null)).toBe(true);
    expect((await h.sceneOf(scene.id)).currentVersionId).toBeNull();
    expect(await errorOf(h.generate(scene.id, 99))).toEqual({
      status: 409,
      code: 'REVISION_CONFLICT',
    });
  });
});
