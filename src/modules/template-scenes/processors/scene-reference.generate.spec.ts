import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import {
  SCENE_27X40,
  SCENE_TABLOID,
  conceptVision,
  useReferenceHarness,
} from '../testing/scene-reference-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { mockReferenceConcept } from '../providers/mock-scene-reference-concept';
import { loadReferenceView } from '../services/scene-reference-view';

describeIfSceneDb('Geração a partir da referência (banco chroma_x_e2e)', () => {
  const h = useReferenceHarness();

  const proposedScene = (overrides?: Parameters<typeof h.newScene>[0]) =>
    h.proposedScene(overrides);
  const editCall = (fake: Awaited<ReturnType<typeof h.run>>, index = 0) =>
    fake.edit.mock.calls[index][0];
  const view = (sceneId: string) => loadReferenceView(h.dataSource.manager, sceneId);

  it('Gerar assim: uma só chamada edit com o encarte reduzido, no tamanho nativo, e a versão 1 fica ready', async () => {
    const { scene, read, revision } = await proposedScene();
    const sent = await h.generate(scene.id, revision);

    const queued = await h.versionOf(sent.versionId);
    expect(queued).toMatchObject({
      operation: 'generate',
      status: 'queued',
      parentVersionId: null,
    });
    expect(queued.metrics).toMatchObject({
      referenceReadVersionId: read.versionId,
      referenceFrom: 'proposed',
      plan: { turn_kind: 'imagem_nova', image: { exact_text: [] }, layer_ops: [] },
    });
    expect((await h.referenceState(read.versionId))?.state).toBe('used');
    expect((await h.messagesOf(scene.id)).at(-1)).toMatchObject({
      role: 'user',
      content: 'Gerar assim.',
    });

    const fake = await h.run(scene.id, sent.versionId);

    expect(fake.generate).not.toHaveBeenCalled();
    expect(fake.edit).toHaveBeenCalledTimes(1);
    const input = editCall(fake);
    const [asset] = await h.assetsOf(scene.id, 'reference');
    expect(input.image.equals(await h.files.read(asset.url))).toBe(true);
    expect(input).toMatchObject({ size: '2352x3504', quality: 'high' });
    expect(input.markup).toBeUndefined();
    expect(input.prompt).toContain('strictly confined to the top 526 px');
    expect(input.prompt).toContain('above y = 447 px');
    expect(input.prompt).toContain('never pure white');
    expect(input.prompt).toContain('no medallions');
    const done = await h.versionOf(sent.versionId);
    expect(done).toMatchObject({ status: 'ready', operation: 'generate' });
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(sent.versionId);
    expect((await h.referenceState(read.versionId))?.usedByVersionIds).toEqual([sent.versionId]);
  });

  it('o juiz confere os elementos usados e o brief ganha o "Conceito do encarte" como pedido atendido', async () => {
    const { scene, revision } = await proposedScene();
    const sent = await h.generate(scene.id, revision);
    await h.run(scene.id, sent.versionId);

    const brief = (await h.sceneOf(scene.id)).brief ?? [];
    const items = brief.filter((item) => item.text !== undefined);
    expect(
      items.some(
        (item) =>
          item.text.startsWith('bandeirinhas de São João no topo') && item.status === 'done',
      ),
    ).toBe(true);
    expect(
      items.some((item) => /^Conceito do encarte: /.test(item.text) && item.status === 'done'),
    ).toBe(true);
    expect(items.some((item) => item.status === 'open')).toBe(false);
  });

  it('custo por etapa: a visão e a imagem somam em totalCostUsd, e cada versão tem o seu', async () => {
    const scene = await h.newScene();
    const vision = conceptVision(mockReferenceConcept);
    const read = await h.proposed(scene, vision.client);
    const sent = await h.generate(scene.id, await h.revisionOf(scene.id));
    await h.run(scene.id, sent.versionId, { vision: vision.client });

    expect((await h.versionOf(read.versionId)).providerCostUsd).toBeCloseTo(0.00084, 5);
    expect((await h.versionOf(sent.versionId)).providerCostUsd).toBeCloseTo(0.14, 5);
    expect((await h.sceneOf(scene.id)).totalCostUsd).toBeCloseTo(0.14084, 5);
  });

  it('jornal: a Externa nasce do encarte (3328x2480, prompt da Externa com o conceito) e a Interna sai sem o encarte', async () => {
    const { scene, revision } = await proposedScene(SCENE_TABLOID);
    const sent = await h.generate(scene.id, revision);
    const fake = await h.run(scene.id, sent.versionId);

    const outer = editCall(fake);
    expect(outer.size).toBe('3328x2480');
    expect(outer.prompt).toContain('OUTER side of a 4-page');
    expect(outer.prompt).toContain('Art concept from the reference flyer');
    expect(outer.prompt).toContain('y from 0 to 372 px');
    expect(outer.prompt).toContain('never pure white');
    expect(outer.prompt).toContain('No badges, no medallions');
    expect(outer.prompt).toContain('Text: no text, no letters');
    expect((await h.versionOf(sent.versionId)).status).toBe('ready');

    const { SceneFacesService } = await import('../services/scene-faces.service');
    const { SceneLockService } = await import('../services/scene-lock.service');
    const faces = new SceneFacesService(h.dataSource, new SceneLockService(h.dataSource), {
      publish: h.publish,
    } as never);
    const inner = await faces.deriveFace(scene.id, 'inner', {
      expectedRevision: await h.revisionOf(scene.id),
      userId: null,
    });
    const second = await h.run(scene.id, inner.versionId);
    const prompt = editCall(second).prompt;
    expect(prompt).toContain('INNER side');
    expect(prompt).not.toMatch(/Art concept|reference image/);
    const [asset] = await h.assetsOf(scene.id, 'reference');
    expect(editCall(second).image.equals(await h.files.read(asset.url))).toBe(false);
  });

  it('frente e verso: a Frente nasce do encarte e o verso é derivado dela pelo prompt fixo, sem o encarte', async () => {
    const { scene, revision } = await proposedScene({ ...SCENE_27X40, layout: 'front_back' });
    const sent = await h.generate(scene.id, revision);
    const fake = await h.run(scene.id, sent.versionId);
    expect(editCall(fake).prompt).toContain('Original background template');

    const { SceneFacesService } = await import('../services/scene-faces.service');
    const { SceneLockService } = await import('../services/scene-lock.service');
    const faces = new SceneFacesService(h.dataSource, new SceneLockService(h.dataSource), {
      publish: h.publish,
    } as never);
    const back = await faces.deriveBack(scene.id, await h.revisionOf(scene.id), null);
    const derived = await h.run(scene.id, back.versionId);
    expect(editCall(derived).prompt).not.toMatch(
      /Art concept|reference image|Original background template/,
    );
    const [asset] = await h.assetsOf(scene.id, 'reference');
    expect(editCall(derived).image.equals(await h.files.read(asset.url))).toBe(false);
  });

  it('mensagem comum com a ficha proposta: a ficha fica discarded e a mensagem segue o fluxo de hoje', async () => {
    const { scene, read } = await proposedScene();
    const sent = await h
      .turns()
      .sendMessage(
        scene.id,
        { content: 'campo verde com sol', expectedRevision: await h.revisionOf(scene.id) } as never,
        null,
      );
    expect((await h.referenceState(read.versionId))?.state).toBe('discarded');
    expect(await h.versionOf(sent.versionId)).toMatchObject({
      operation: 'generate',
      status: 'queued',
    });
  });

  it('imagem nova depois da geração por encarte: generate, sem o encarte nem imagem de referência', async () => {
    const { scene, revision } = await proposedScene();
    const first = await h.generate(scene.id, revision);
    await h.run(scene.id, first.versionId);
    const current = await h.sceneOf(scene.id);
    const next = await h.queueRedraw(current, {
      plan: directorPlan({
        turn_kind: 'imagem_nova',
        will_change_image: true,
        what_to_put: 'outra imagem',
      }),
      request: 'gere outra imagem',
      number: 20,
      operation: 'generate',
    });
    const fake = await h.run(scene.id, next.id);

    expect(fake.generate).toHaveBeenCalledTimes(1);
    expect(fake.edit).not.toHaveBeenCalled();
    expect(fake.generate.mock.calls[0][0].prompt).not.toMatch(/reference image/i);
    const brief = (await h.sceneOf(scene.id)).brief ?? [];
    expect(brief.some((item) => /^Conceito do encarte: /.test(item.text))).toBe(true);
  });

  it('juiz vê conteúdo vazado: a versão vira a atual e o chat relata o que o juiz viu', async () => {
    const { scene, revision } = await proposedScene();
    const sent = await h.generate(scene.id, revision);
    const vision = conceptVision(() => ({}));
    const leaking = {
      compare: jest.fn(async (input: Parameters<typeof vision.client.compare>[0]) => {
        const real = await vision.client.compare(input);
        return input.prompt.includes('conteudo_indevido')
          ? {
              ...real,
              text: JSON.stringify({
                ...JSON.parse(real.text),
                conteudo_indevido: 'selo redondo vazio no cabeçalho',
              }),
            }
          : real;
      }),
    };
    await h.run(scene.id, sent.versionId, { vision: leaking });

    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(sent.versionId);
    const reply = (
      await h.dataSource.manager.find(TemplateSceneMessage, {
        where: { versionId: sent.versionId, role: 'assistant' },
      })
    )[0].content;
    expect(reply).toContain(
      'vi algo que não devia estar no fundo: selo redondo vazio no cabeçalho',
    );
    expect(reply).toContain('Voltar para a anterior');
  });

  it('o juiz de uma imagem que não nasceu do encarte não recebe a pergunta de conteúdo indevido', async () => {
    const queued = await h.queuedScene('rio azul');
    const vision = conceptVision(() => ({}));
    await h.run(queued.scene.id, queued.version.id, { vision: vision.client });
    const judgePrompts = vision.compare.mock.calls.map((call) => call[0].prompt);
    expect(judgePrompts.length).toBeGreaterThan(0);
    expect(judgePrompts.some((prompt) => prompt.includes('conteudo_indevido'))).toBe(false);
  });

  it('a ficha em detalhe: resumo, correções que restam e o botão', async () => {
    const { scene, read } = await proposedScene();
    expect(await view(scene.id)).toMatchObject({
      readVersionId: read.versionId,
      state: 'proposed',
      fileName: 'junina.jpg',
      revisionsLeft: 5,
      canRetry: false,
      summary: { theme: 'festa junina' },
    });
    expect((await view(scene.id))?.previewUrl).toMatch(/^\/uploads\/template-scenes\//);
    expect(await view((await h.newScene()).id)).toBeNull();
  });
});
