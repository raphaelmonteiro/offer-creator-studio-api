import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste, EAN_IT_ENABLED } from '../ai/ean/ean-test-db';
import { GalleryFolder } from './entities/gallery-folder.entity';
import { GalleryImage } from './entities/gallery-image.entity';
import { GalleryService } from './gallery.service';

/**
 * Registro de imagem importada (foto DotCompany) contra Postgres real:
 *
 *   EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest gallery.register-imported
 */
const d = EAN_IT_ENABLED ? describe : describe.skip;

// EANs exclusivos desta suíte: as suítes rodam em paralelo e o índice único
// de foto DotCompany por EAN é global no banco de teste.
const EAN = '7898960982350';
const META = {
  title: 'LEITE CONDENSADO MOÇA LATA 395G',
  ean: EAN,
  eanSource: 'dotcompany',
  eanVerifiedBy: 'exact',
  eanConfidence: 1,
  eanStatus: 'resolved',
};

d('GalleryService.registerImportedImage (Postgres real)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
  });
  const limpar = async () => {
    await ds.query(`DELETE FROM gallery_images WHERE filename LIKE 'it-dotcompany-%'`);
    await ds.query(`DELETE FROM gallery_folders WHERE name = 'DotCompany IT'`);
  };
  beforeEach(limpar);
  afterAll(async () => {
    await limpar();
    await ds.destroy();
  });

  function criar() {
    const embedder = {
      embedAndStoreForImage: jest.fn(async () => true),
      embedAndStoreMetadataForImage: jest.fn(async () => true),
      saveImageMetadata: jest.fn(),
    };
    const extractor = { isEnabled: () => true, extractFromImage: jest.fn() };
    const moduleRef = {
      get: (name: string) => (name === 'GalleryEmbeddingService' ? embedder : extractor),
    };
    const clientPreferred = { bulkAssign: jest.fn(async () => ({ affectedImages: 1 })) };
    const svc = new GalleryService(
      ds.getRepository(GalleryImage),
      ds.getRepository(GalleryFolder),
      ds,
      {} as never,
      moduleRef as never,
      clientPreferred as never,
    );
    return { svc, embedder, extractor, clientPreferred };
  }

  const params = (filename: string) => ({
    filename,
    url: `http://cdn/uploads/gallery/${filename}`,
    mimeType: 'image/png',
    size: 1234,
    metadata: META,
    folderName: 'DotCompany IT',
  });

  it('grava metadata pronto, dispara embeddings e NÃO chama a visão', async () => {
    const { svc, embedder, extractor } = criar();
    const { image, created } = await svc.registerImportedImage(params('it-dotcompany-a.png'));
    await new Promise((r) => setTimeout(r, 50));

    expect(created).toBe(true);
    const [row] = await ds.query(
      `SELECT i.metadata, i.metadata_status, f.name AS folder
         FROM gallery_images i LEFT JOIN gallery_folders f ON f.id = i."folderId" WHERE i.id = $1`,
      [image.id],
    );
    expect(row.metadata).toMatchObject({
      ean: EAN,
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
    });
    expect(row.metadata_status).toBe('ready');
    expect(row.folder).toBe('DotCompany IT');
    expect(embedder.embedAndStoreForImage).toHaveBeenCalled();
    expect(embedder.embedAndStoreMetadataForImage).toHaveBeenCalledWith(image.id, META);
    expect(extractor.extractFromImage).not.toHaveBeenCalled();
  });

  it('segunda foto DotCompany do mesmo EAN devolve a existente (created: false)', async () => {
    const { svc } = criar();
    const a = await svc.registerImportedImage(params('it-dotcompany-a.png'));
    const b = await svc.registerImportedImage(params('it-dotcompany-b.png'));
    expect(b.created).toBe(false);
    expect(b.image.id).toBe(a.image.id);
  });

  it('pasta criada uma vez só, mesmo com registros em paralelo; cliente vira preferido', async () => {
    const { svc, clientPreferred } = criar();
    const client = '0b5c7a3e-0000-4000-8000-000000000001';
    await Promise.all([
      svc.registerImportedImage({
        ...params('it-dotcompany-c.png'),
        metadata: { ...META, ean: '7896437900012' },
        clientIds: [client],
      }),
      svc.registerImportedImage({
        ...params('it-dotcompany-d.png'),
        metadata: { ...META, ean: '7896003706895' },
      }),
    ]);
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM gallery_folders WHERE name = 'DotCompany IT'`,
    );
    expect(n).toBe(1);
    expect(clientPreferred.bulkAssign).toHaveBeenCalledWith([expect.any(String)], [client], 'add');
  });
});
