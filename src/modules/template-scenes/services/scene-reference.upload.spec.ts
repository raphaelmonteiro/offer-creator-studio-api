import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import {
  SCENE_TABLOID,
  uploadedFile,
  useReferenceHarness,
} from '../testing/scene-reference-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { errorOf } from '../testing/scene-test-helpers';
import { insertReadyVersion, pointFace } from '../testing/scene-fixtures';
import { readOf } from './scene-reference-state';
import { pruneSceneAssets } from './scene-retention';

describeIfSceneDb('Envio do encarte de referência (banco chroma_x_e2e)', () => {
  const h = useReferenceHarness();

  const upload = (sceneId: string, file: Awaited<ReturnType<typeof uploadedFile>>, revision = 0) =>
    h.api().upload(sceneId, file, { expectedRevision: String(revision), userId: null });

  async function nothingWritten(sceneId: string) {
    expect(await h.versions(sceneId)).toHaveLength(0);
    expect(await h.assetsOf(sceneId, 'reference')).toHaveLength(0);
    await expect(fs.stat(path.join(h.uploadsDir, 'template-scenes', sceneId))).rejects.toThrow();
  }

  it('JPEG de 3000x4400: cópia reduzida de 1047x1536 sem expiração, mensagem com o anexo e job na fila', async () => {
    const scene = await h.newScene();
    const file = await uploadedFile('junina.jpg', [3000, 4400]);

    const sent = await upload(scene.id, file);

    expect(sent).toMatchObject({ revision: 1 });
    expect(h.publish).toHaveBeenCalledWith(
      QUEUES.TEMPLATE_SCENE_TURN,
      expect.objectContaining({ sceneId: scene.id, versionId: sent.versionId }),
      expect.objectContaining({ retryLimit: 0 }),
    );
    const [asset] = await h.assetsOf(scene.id, 'reference');
    expect(asset).toMatchObject({
      width: 1047,
      height: 1536,
      expiresAt: null,
      versionId: sent.versionId,
    });
    const meta = await sharp(await h.files.read(asset.url)).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1047, height: 1536 });
    const files = await fs.readdir(
      path.join(h.uploadsDir, 'template-scenes', scene.id, sent.versionId),
    );
    expect(files).toHaveLength(1); // só a cópia reduzida: o original não é guardado
    const version = await h.versionOf(sent.versionId);
    expect(version).toMatchObject({ operation: 'read_reference', status: 'queued', faceIndex: 0 });
    expect(readOf(version)).toMatchObject({
      state: 'reading',
      assetId: asset.id,
      origin: { fileName: 'junina.jpg', mimeType: 'image/jpeg', widthPx: 3000, heightPx: 4400 },
    });
    expect(readOf(version)?.origin.sha256).toMatch(/^[0-9a-f]{64}$/);
    const message = await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
      versionId: sent.versionId,
    });
    expect(message).toMatchObject({
      role: 'user',
      content: 'Encarte enviado como referência: junina.jpg.',
      attachments: [{ assetId: asset.id, name: 'junina.jpg' }],
    });
  });

  it('PDF, arquivo grande, imagem pequena e extensão trocada: 422 REFERENCE_INVALID e nada gravado', async () => {
    const cases: Array<[string, Awaited<ReturnType<typeof uploadedFile>>, string]> = [];
    const pdf = Buffer.from('%PDF-1.4 fake');
    cases.push([
      'pdf',
      { buffer: pdf, mimetype: 'application/pdf', size: pdf.length, originalname: 'e.pdf' },
      'PDF ainda não',
    ]);
    const big = Buffer.alloc(21 * 1024 * 1024, 1);
    cases.push([
      'grande',
      { buffer: big, mimetype: 'image/png', size: big.length, originalname: 'g.png' },
      'passa de 20 MB',
    ]);
    cases.push(['pequena', await uploadedFile('p.jpg', [600, 780]), 'pequena demais']);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"/>');
    cases.push([
      'svg',
      { buffer: svg, mimetype: 'image/jpeg', size: svg.length, originalname: 's.jpg' },
      'JPG ou PNG',
    ]);
    cases.push([
      'lixo',
      { buffer: Buffer.from('nada'), mimetype: 'image/jpeg', size: 4, originalname: 'x.jpg' },
      'Não foi possível ler',
    ]);
    for (const [, file, message] of cases) {
      const scene = await h.newScene();
      const body = await upload(scene.id, file).then(
        () => null,
        (error) => (error as { getResponse(): { code: string; message: string } }).getResponse(),
      );
      expect(body).toMatchObject({ code: 'REFERENCE_INVALID' });
      expect(body?.message).toContain(message);
      await nothingWritten(scene.id);
    }
  });

  it('expectedRevision que não é inteiro: 400', async () => {
    const scene = await h.newScene();
    const result = h
      .api()
      .upload(scene.id, await uploadedFile(), { expectedRevision: 'abc', userId: null });
    expect(await errorOf(result)).toEqual({ status: 400, code: 'BAD_REQUEST' });
  });

  it('depois da primeira imagem: 422 REFERENCE_ONLY_AT_START, nada gravado e o arquivo some do disco', async () => {
    const scene = await h.newScene();
    const { version } = await insertReadyVersion(h.dataSource, scene, 1);
    await pointFace(h.dataSource, scene, version.id);

    expect(await errorOf(upload(scene.id, await uploadedFile()))).toEqual({
      status: 422,
      code: 'REFERENCE_ONLY_AT_START',
    });
    expect(await h.assetsOf(scene.id, 'reference')).toHaveLength(0);
    const folder = path.join(h.uploadsDir, 'template-scenes', scene.id);
    const leftovers = await fs.readdir(folder).catch(() => []);
    for (const dir of leftovers) {
      expect(await fs.readdir(path.join(folder, dir))).not.toContainEqual(
        expect.stringMatching(/^reference-/),
      );
    }
  });

  it('revisão velha: 409 REVISION_CONFLICT; cena ocupada: 409 SCENE_BUSY; nada gravado', async () => {
    const scene = await h.newScene();
    expect(await errorOf(upload(scene.id, await uploadedFile(), 3))).toEqual({
      status: 409,
      code: 'REVISION_CONFLICT',
    });
    const first = await upload(scene.id, await uploadedFile());
    expect(await errorOf(upload(scene.id, await uploadedFile(), 1))).toEqual({
      status: 409,
      code: 'SCENE_BUSY',
    });
    expect(await h.versions(scene.id)).toHaveLength(1);
    expect(await h.assetsOf(scene.id, 'reference')).toHaveLength(1);
    expect(first.versionId).toBeDefined();
  });

  it('segundo encarte com a ficha proposta: a anterior fica discarded e a nova leitura começa', async () => {
    const scene = await h.newScene();
    const first = await h.proposed(scene);
    expect((await h.referenceState(first.versionId))?.state).toBe('proposed');

    const second = await h.upload(scene.id, 'outro.jpg');

    expect((await h.referenceState(first.versionId))?.state).toBe('discarded');
    expect((await h.referenceState(second.versionId))?.state).toBe('reading');
    expect(await h.assetsOf(scene.id, 'reference')).toHaveLength(2);
  });

  it('jornal: a leitura é da Externa (face 0) e a Interna continua sem versão', async () => {
    const scene = await h.newScene(SCENE_TABLOID);
    const sent = await h.upload(scene.id);
    const versions = await h.versions(scene.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: sent.versionId,
      faceIndex: 0,
      operation: 'read_reference',
    });
  });

  it('o GC não expira nem poda o encarte reduzido (papel reference)', async () => {
    const scene = await h.newScene();
    await h.upload(scene.id);
    await pruneSceneAssets(h.dataSource.manager, scene);
    const [asset] = await h.assetsOf(scene.id, 'reference');
    expect(asset).toMatchObject({ expiresAt: null, purgedAt: null });
  });
});
