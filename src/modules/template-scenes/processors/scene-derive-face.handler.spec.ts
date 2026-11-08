import * as sharp from 'sharp';
import { buildBackPrompt, faceZones } from '../domain/scene-faces';
import { findSceneFormat, SceneFormatSpec } from '../domain/scene-formats';
import { SceneProviderError } from '../providers/scene-image-provider';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { failureReply } from '../scene-texts';
import { SceneFacesService } from '../services/scene-faces.service';
import { SceneLockService } from '../services/scene-lock.service';
import { FB_HEIGHT, FB_WIDTH, useFacesHarness } from '../testing/scene-faces-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { fakeQueue } from '../testing/scene-test-helpers';

describeIfSceneDb('Verso derivado no worker (banco chroma_x_e2e)', () => {
  const h = useFacesHarness();

  /** Cena com a frente pronta e a derivação pedida pelo botão (a versão `queued` do verso). */
  async function derivationQueued() {
    const made = await h.frontBackScene({ front: true });
    const scene = await h.sceneOf(made.scene.id);
    const queued = await new SceneFacesService(
      h.dataSource,
      new SceneLockService(h.dataSource),
      fakeQueue().service,
    ).deriveBack(scene.id, scene.revision, null);
    return { ...made, versionId: queued.versionId };
  }
  const costOf = async (sceneId: string) => (await h.sceneOf(sceneId)).totalCostUsd;
  const backFace = (sceneId: string) =>
    h.dataSource.manager.findOneByOrFail(TemplateSceneFace, { sceneId, index: 1 });

  it('Verso derivado: a edição leva a master da frente, e a versão do verso fica pronta no tamanho nativo, sem camadas', async () => {
    const { scene, front, versionId } = await derivationQueued();
    const fake = h.fakeProvider(async () => h.okResult(0.131));

    await h.processorWith(fake.provider).process(h.job(scene.id, versionId));

    expect(fake.edit).toHaveBeenCalledTimes(1);
    expect(fake.generate).not.toHaveBeenCalled();
    const call = fake.edit.mock.calls[0][0];
    const frontMaster = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: front?.masterAssetId as string,
    });
    expect((call.image as Buffer).equals(await h.files.read(frontMaster.url))).toBe(true);
    const format = findSceneFormat('folheto-27x40') as SceneFormatSpec;
    expect(call.prompt).toBe(
      buildBackPrompt({
        format,
        widthPx: FB_WIDTH,
        heightPx: FB_HEIGHT,
        zones: faceZones(format, 'back'),
      }),
    );
    expect(call.size).toBe(`${FB_WIDTH}x${FB_HEIGHT}`);
    expect(call.markup).toBeUndefined();

    const done = await h.versionOf(versionId);
    expect(done).toMatchObject({
      status: 'ready',
      step: 'done',
      faceIndex: 1,
      operation: 'derive_face',
      derivedFromVersionId: front?.id,
      parentVersionId: null,
      elements: [],
      providerCostUsd: 0.131,
    });
    const master = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: done.masterAssetId as string,
    });
    const meta = await sharp(await h.files.read(master.url)).metadata();
    expect([meta.width, meta.height]).toEqual([FB_WIDTH, FB_HEIGHT]);
    expect(await costOf(scene.id)).toBeCloseTo(0.131, 6);
    expect((await backFace(scene.id)).currentVersionId).toBe(versionId);
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(front?.id);
    const reply = await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
      versionId,
      role: 'assistant',
    });
    expect(reply).toMatchObject({
      content: 'Pronto, fiz o verso a partir da frente atual. Peça aqui os ajustes do verso.',
      faceIndex: 1,
    });
    // pronto na fila de sincronização do template, como toda versão que fica `ready`
    expect(h.syncQueue.publish).toHaveBeenCalledTimes(1);
  });

  it('não chama o juiz nem o Diretor: só uma chamada de imagem em metrics.calls', async () => {
    const { scene, versionId } = await derivationQueued();
    const fake = h.fakeProvider(async () => h.okResult(0.12));

    await h.processorWith(fake.provider).process(h.job(scene.id, versionId));

    const done = await h.versionOf(versionId);
    expect(done.metrics.calls).toHaveLength(1);
    expect(done.metrics.calls?.[0]).toMatchObject({ kind: 'edit', status: 'done' });
    expect(done.metrics.judge).toBeUndefined();
  });

  it('Derivação falha: a versão fica failed com PROVIDER_CONTENT_POLICY, o chat explica e o verso continua vazio', async () => {
    const { scene, front, versionId } = await derivationQueued();
    const fake = h.fakeProvider(async () => {
      throw new SceneProviderError('PROVIDER_CONTENT_POLICY', 'recusado', 0.01);
    });

    await h.processorWith(fake.provider).process(h.job(scene.id, versionId));

    const done = await h.versionOf(versionId);
    expect(done).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_CONTENT_POLICY' });
    expect((await backFace(scene.id)).currentVersionId).toBeNull();
    const reply = await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
      versionId,
      role: 'assistant',
    });
    expect(reply.content).toBe(failureReply('PROVIDER_CONTENT_POLICY'));
    expect(reply.status).toBe('failed');
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(front?.id);
  });

  it('Parar a derivação: o resultado é descartado, a versão fica cancelled com o custo e o verso continua vazio', async () => {
    const { scene, versionId } = await derivationQueued();
    const fake = h.fakeProvider(async () => {
      await h.dataSource.manager.update(
        TemplateSceneVersion,
        { id: versionId },
        { cancelRequestedAt: new Date() },
      );
      return h.okResult(0.12);
    });

    await h.processorWith(fake.provider).process(h.job(scene.id, versionId));

    const done = await h.versionOf(versionId);
    expect(done).toMatchObject({ status: 'cancelled', providerCostUsd: 0.12, masterAssetId: null });
    expect(await costOf(scene.id)).toBeCloseTo(0.12, 6);
    expect((await backFace(scene.id)).currentVersionId).toBeNull();
    expect(await h.dataSource.manager.countBy(TemplateSceneAsset, { versionId })).toBe(0);
  });

  it('Job entregue duas vezes: o worker sai sem chamar o provedor e o custo não muda', async () => {
    const { scene, versionId } = await derivationQueued();
    const fake = h.fakeProvider(async () => h.okResult(0.13));
    const processor = h.processorWith(fake.provider);
    await processor.process(h.job(scene.id, versionId));
    const cost = await costOf(scene.id);

    await processor.process(h.job(scene.id, versionId));

    expect(fake.edit).toHaveBeenCalledTimes(1);
    expect(await costOf(scene.id)).toBe(cost);
  });

  it('a master da frente sumiu: falha sem chamada paga', async () => {
    const { scene, front, versionId } = await derivationQueued();
    await h.dataSource.manager.update(
      TemplateSceneAsset,
      { id: front?.masterAssetId as string },
      { purgedAt: new Date() },
    );
    const fake = h.fakeProvider(async () => h.okResult());

    await h.processorWith(fake.provider).process(h.job(scene.id, versionId));

    expect(fake.edit).not.toHaveBeenCalled();
    expect(await h.versionOf(versionId)).toMatchObject({
      status: 'failed',
      errorCode: 'PROVIDER_ERROR',
    });
  });
});
