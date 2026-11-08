import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { SceneElement } from '../domain/scene.types';
import { layerOpsToActions } from '../domain/scene-director-layers';
import { DirectorPlan } from '../domain/scene-director-schema';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { insertAsset } from '../testing/scene-fixtures';
import { describeIfSceneDb } from '../testing/scene-test-db';

const LOGO: SceneElement = {
  id: 'logo-1',
  kind: 'logo',
  name: 'Logo 1',
  x: 0.2,
  y: 0.06,
  w: 0.3,
  aspect: 2,
  rotation: 0,
  z: 1,
  assetId: 'asset-x',
};
const op = (
  overrides: Partial<DirectorPlan['layer_ops'][number]>,
): DirectorPlan['layer_ops'][number] => ({
  op: 'move',
  layer: null,
  text: null,
  position: null,
  replace: false,
  ...overrides,
});

describe('layerOpsToActions', () => {
  const input = { elements: [LOGO], attachmentId: 'asset-new', hintElementId: null };

  it('mover, redimensionar e tirar a logo pelo tipo', () => {
    const moved = layerOpsToActions(
      [op({ layer: { kind: 'logo', name: null, side: 'right', direction: null } })],
      input,
    );
    expect(moved).toEqual({
      ok: true,
      actions: [{ type: 'move', target: { kind: 'logo' }, side: 'right' }],
    });
    const resized = layerOpsToActions(
      [op({ op: 'resize', layer: { kind: 'logo', name: null, side: null, direction: 'smaller' } })],
      input,
    );
    expect(resized).toMatchObject({ actions: [{ type: 'resize', direction: 'smaller' }] });
    expect(
      layerOpsToActions(
        [op({ op: 'remove', layer: { kind: 'logo', name: null, side: null, direction: null } })],
        input,
      ),
    ).toMatchObject({
      actions: [{ type: 'remove', target: { kind: 'logo' } }],
    });
  });

  it('position.below segue para a ação, de texto e de logo', () => {
    const below = { kind: 'logo' as const, name: null };
    const text = layerOpsToActions(
      [
        op({
          op: 'set_text',
          text: { value: 'Ofertas', placement: 'below-logo' },
          position: { side: 'left', zone: 'header', below },
        }),
      ],
      input,
    );
    expect(text).toMatchObject({
      ok: true,
      actions: [{ type: 'set_text', position: { side: 'left', zone: 'header', below } }],
    });
    const logo = layerOpsToActions(
      [op({ op: 'add_logo', position: { side: 'right', zone: 'footer', below } })],
      input,
    );
    expect(logo).toMatchObject({ actions: [{ type: 'add_logo', below }] });
  });

  it('o elemento selecionado do mesmo tipo é a dica: vira o alvo exato', () => {
    const result = layerOpsToActions(
      [op({ layer: { kind: 'logo', name: null, side: 'left', direction: null } })],
      { ...input, hintElementId: 'logo-1' },
    );
    expect(result).toMatchObject({ actions: [{ target: { elementId: 'logo-1' } }] });
  });

  it('camada antiga (generated): pelo nome, pela dica, e sem nenhum dos dois pede a seleção', () => {
    const balloon = { ...LOGO, id: 'gen-1', kind: 'generated' as const, name: 'Balão vermelho' };
    const cloud = { ...LOGO, id: 'gen-2', kind: 'generated' as const, name: 'Nuvem' };
    const layer = { kind: 'generated' as const, name: 'balão', side: null, direction: null };
    expect(
      layerOpsToActions([op({ layer })], { ...input, elements: [balloon, cloud] }),
    ).toMatchObject({
      actions: [{ target: { elementId: 'gen-1' } }],
    });
    expect(
      layerOpsToActions([op({ layer: { ...layer, name: null } })], {
        ...input,
        elements: [balloon, cloud],
        hintElementId: 'gen-2',
      }),
    ).toMatchObject({ actions: [{ target: { elementId: 'gen-2' } }] });
    expect(
      layerOpsToActions([op({ layer: { ...layer, name: null } })], {
        ...input,
        elements: [balloon, cloud],
      }),
    ).toEqual({
      ok: false,
      reply: 'Selecione na prévia a camada que quer mudar. Nada foi alterado.',
    });
  });

  it('logo anexada exige o anexo; texto exato troca o texto da dica', () => {
    const add = op({ op: 'add_logo', position: { side: 'left', zone: 'header' } });
    expect(layerOpsToActions([add], input)).toMatchObject({
      actions: [{ type: 'add_logo', assetId: 'asset-new', side: 'left', zone: 'header' }],
    });
    expect(layerOpsToActions([add], { ...input, attachmentId: null })).toMatchObject({ ok: false });
    const text = op({
      op: 'set_text',
      text: { value: 'Ofertas', placement: 'bottom' },
      layer: { kind: 'text', name: null, side: null, direction: null },
    });
    const textEl = { ...LOGO, id: 'text-1', kind: 'text' as const };
    expect(
      layerOpsToActions([text], { ...input, elements: [textEl], hintElementId: 'text-1' }),
    ).toMatchObject({
      actions: [{ type: 'set_text', text: 'Ofertas', replace: true, elementId: 'text-1' }],
    });
  });
});

describeIfSceneDb('Camadas pelo chat, no consumer do Diretor (banco chroma_x_e2e)', () => {
  const h = useDirectorHarness();
  const imageJobs = () =>
    h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);

  async function sceneWithLogoAsset() {
    const ready = await h.readyScene({ elements: [] });
    const logoAsset = await insertAsset(h.dataSource, ready.version, 'logo', {
      width: 400,
      height: 200,
    });
    return { ...ready, logoAsset };
  }
  const answer = (ops: DirectorPlan['layer_ops']) =>
    directorAnswer(
      directorPlan({ turn_kind: 'camada', reply: 'Vou ajustar as camadas.', layer_ops: ops }),
    );
  const lastReply = async (sceneId: string) =>
    (
      await h.dataSource.manager.find(TemplateSceneMessage, {
        where: { sceneId, role: 'assistant' },
        order: { createdAt: 'DESC' },
        take: 1,
      })
    )[0]?.content;

  it('Logo e frase: as duas camadas aparecem, o custo de imagem não muda e não há janela nem job de imagem', async () => {
    const { scene, version: v1, masterAsset, previewAsset, logoAsset } = await sceneWithLogoAsset();
    const message =
      'coloca a logo à esquerda no cabeçalho e escreve "Ofertas da semana" embaixo dela';
    const sent = await h.post(scene.id, message, { attachments: [{ assetId: logoAsset.id }] });
    const { client } = h.directorClient(async () =>
      answer([
        op({ op: 'add_logo', position: { side: 'left', zone: 'header' } }),
        op({ op: 'set_text', text: { value: 'Ofertas da semana', placement: 'below-logo' } }),
      ]),
    );
    const before = (await h.sceneOf(scene.id)).totalCostUsd;

    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    const done = await h.versionOf(sent.versionId);
    expect(done).toMatchObject({
      operation: 'set_layer',
      status: 'ready',
      step: 'done',
      parentVersionId: v1.id,
      masterAssetId: masterAsset.id,
      previewAssetId: previewAsset.id,
    });
    expect(done.elements.map((e) => [e.kind, e.assetId ?? e.text])).toEqual([
      ['logo', logoAsset.id],
      ['text', 'Ofertas da semana'],
    ]);
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(sent.versionId);
    expect(imageJobs()).toHaveLength(0);
    expect(done.metrics.calls).toBeUndefined();
    expect((await h.sceneOf(scene.id)).totalCostUsd - before).toBeCloseTo(0.000435, 6);
    expect(await lastReply(scene.id)).toContain(
      'Coloquei a frase “Ofertas da semana” como camada de texto',
    );
    expect(await lastReply(scene.id)).not.toContain('Alterado apenas');
    const assets = await h.dataSource.manager.countBy(TemplateSceneAsset, {
      sceneId: scene.id,
      role: 'master',
    });
    expect(assets).toBe(1);
  });

  it('Texto embaixo da logo não a cobre (repro de B3): topo do texto abaixo da base da logo, alinhado à esquerda, sem imagem', async () => {
    const { scene, logoAsset } = await sceneWithLogoAsset();
    const message =
      'coloca a logo no cabeçalho à esquerda e escreve "Ofertas da semana" embaixo dela, como texto editável';
    const sent = await h.post(scene.id, message, { attachments: [{ assetId: logoAsset.id }] });
    // Como o modelo devolveu na validação: as duas no cabeçalho à esquerda, o texto com `below` apontando a logo.
    const { client } = h.directorClient(async () =>
      answer([
        op({ op: 'add_logo', position: { side: 'left', zone: 'header' } }),
        op({
          op: 'set_text',
          text: { value: 'Ofertas da semana', placement: 'below-logo' },
          position: { side: 'left', zone: 'header', below: { kind: 'logo', name: null } },
        }),
      ]),
    );

    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    const done = await h.versionOf(sent.versionId);
    expect(done.status).toBe('ready');
    const logo = done.elements.find((e) => e.kind === 'logo') as SceneElement;
    const text = done.elements.find((e) => e.kind === 'text') as SceneElement;
    const heightOf = (e: SceneElement) => (e.w * scene.widthPx) / e.aspect / scene.heightPx;
    expect(text.y).not.toBeCloseTo(logo.y, 3);
    expect(text.y - heightOf(text) / 2).toBeGreaterThan(logo.y + heightOf(logo) / 2);
    expect(text.x - text.w / 2).toBeCloseTo(logo.x - logo.w / 2, 5);
    expect(imageJobs()).toHaveLength(0);
    expect(done.metrics.calls).toBeUndefined();
  });

  it('Não cabe embaixo da camada: nada é criado nem movido, a leitura termina rejected e o chat diz que não cabe', async () => {
    const edge = { ...LOGO, y: 0.97 };
    const { scene, version: v1 } = await h.readyScene({ elements: [edge] });
    const sent = await h.post(scene.id, 'escreve "Ofertas da semana" embaixo da logo');
    const { client } = h.directorClient(async () =>
      answer([
        op({
          op: 'set_text',
          text: { value: 'Ofertas da semana', placement: 'below-logo' },
          position: { side: 'left', zone: 'footer', below: { kind: 'logo', name: null } },
        }),
      ]),
    );

    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    expect((await h.versionOf(sent.versionId)).status).toBe('rejected');
    expect(await lastReply(scene.id)).toBe(
      'Não cabe embaixo de “Logo 1”. Diga onde quer, ou arraste no quadro.',
    );
    const stored = await h.sceneOf(scene.id);
    expect(stored.currentVersionId).toBe(v1.id);
    expect((await h.versionOf(v1.id)).elements).toEqual([edge]);
    expect(imageJobs()).toHaveLength(0);
  });

  it('Camada não espera: passar a logo para a direita muda sem janela e sem chamada de imagem', async () => {
    const { scene, version: v1 } = await h.readyScene({ elements: [LOGO] });
    const sent = await h.post(scene.id, 'passa a logo para a direita');
    const { client } = h.directorClient(async () =>
      answer([op({ layer: { kind: 'logo', name: null, side: 'right', direction: null } })]),
    );
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    const done = await h.versionOf(sent.versionId);
    expect(done.status).toBe('ready');
    expect(done.elements[0].x).toBeCloseTo(0.8, 5);
    expect(v1.elements[0].x).toBe(0.2);
    expect(imageJobs()).toHaveLength(0);
    expect(done.metrics.windowEndsAt).toBeUndefined();
  });

  it('Camada não espera a imagem de outra cena: com a imagem da cena A presa, a logo da cena B muda depois do Diretor', async () => {
    const { scene: sceneA, version: versionA } = await h.queuedScene('campo verde');
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const { provider, generate } = h.fakeProvider(async () => {
      await blocked;
      return h.okResult();
    });
    const imageRun = h.processorWith(provider).process(h.job(sceneA.id, versionA.id));
    while (generate.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    const { scene: sceneB } = await h.readyScene({ elements: [LOGO] });
    const sent = await h.post(sceneB.id, 'passa a logo para a direita');
    const { client } = h.directorClient(async () =>
      answer([op({ layer: { kind: 'logo', name: null, side: 'right', direction: null } })]),
    );
    await h.directorProcessor(client).process({ sceneId: sceneB.id, versionId: sent.versionId });

    expect((await h.versionOf(sent.versionId)).status).toBe('ready');
    expect((await h.versionOf(versionA.id)).status).toBe('running');
    release();
    await imageRun;
  });

  it('Pedido sobre logo que não existe: o chat diz que não encontrou a logo, sem chamada de imagem', async () => {
    const { scene } = await h.readyScene({ elements: [] });
    const sent = await h.post(scene.id, 'passa a logo para a direita');
    const { client } = h.directorClient(async () =>
      answer([op({ layer: { kind: 'logo', name: null, side: 'right', direction: null } })]),
    );
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    const done = await h.versionOf(sent.versionId);
    expect(done.status).toBe('rejected');
    expect(await lastReply(scene.id)).toBe('Não encontrei a logo na cena. Nada foi alterado.');
    expect(imageJobs()).toHaveLength(0);
  });

  it('camada numa cena sem imagem: o chat diz que ainda não há imagem', async () => {
    const { version, scene } = await h.runTurn(
      'passa a logo para a direita',
      async () =>
        answer([op({ layer: { kind: 'logo', name: null, side: 'right', direction: null } })]),
      {
        noImage: true,
      },
    );
    expect(version.status).toBe('rejected');
    expect(await lastReply(scene.id)).toContain('Ainda não há imagem');
  });

  it('Texto fora da mensagem: a saída é recusada como inválida e a versão falha sem alterar camadas', async () => {
    const { scene } = await h.readyScene({ elements: [LOGO] });
    const sent = await h.post(scene.id, 'escreve "Ofertas da semana" embaixo');
    const { client, plan } = h.directorClient(async () =>
      answer([op({ op: 'set_text', text: { value: 'Oferta imperdível', placement: 'bottom' } })]),
    );
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    expect(plan).toHaveBeenCalledTimes(2);
    expect(await h.versionOf(sent.versionId)).toMatchObject({
      status: 'failed',
      errorCode: 'DIRECTOR_UNAVAILABLE',
    });
    expect((await h.sceneOf(scene.id)).currentVersionId).not.toBe(sent.versionId);
  });

  it('Camada não abre pedido: o plano de camada com requests não muda a lista, e o chat nunca diz "Ainda não vi"', async () => {
    const { scene } = await h.readyScene({ elements: [LOGO] });
    const sent = await h.post(scene.id, 'passa a logo para a direita');
    const { client } = h.directorClient(async () =>
      directorAnswer(
        directorPlan({
          turn_kind: 'camada',
          reply: 'Vou ajustar as camadas.',
          layer_ops: [op({ layer: { kind: 'logo', name: null, side: 'right', direction: null } })],
          requests: [
            { id: null, text: 'passar a logo para a direita', action: 'open', quote: null },
          ],
        }),
      ),
    );
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    expect((await h.versionOf(sent.versionId)).status).toBe('ready');
    expect((await h.sceneOf(scene.id)).brief).toEqual([]);
    expect(await lastReply(scene.id)).not.toContain('Ainda não vi');
  });
});
