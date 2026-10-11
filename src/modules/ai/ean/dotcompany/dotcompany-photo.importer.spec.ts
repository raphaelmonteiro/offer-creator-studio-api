// O binário do sharp não carrega no host (macOS) — e aqui só importa que a
// conversão para PNG foi pedida.
jest.mock('sharp', () => {
  const chain = {
    flatten: jest.fn(() => chain),
    png: jest.fn(() => chain),
    toBuffer: jest.fn(async () => Buffer.from('png-normalizado')),
  };
  return jest.fn(() => chain);
});

import { Logger } from '@nestjs/common';
import { DotcompanyPhotoImporter, DOTCOMPANY_GALLERY_FOLDER } from './dotcompany-photo.importer';
import { DotcompanyLookup } from './entities/dotcompany-lookup.entity';

const EAN = '7891000100103';
const URL1 = 'https://app.dotcompany.com.br/publico/catalogo/img/7891000100103.png?exp=1';
const URL2 = 'https://app.dotcompany.com.br/publico/catalogo/img/7891000100103.png?exp=2';

function lookup(
  extra: Partial<DotcompanyLookup> = {},
  url: string | null = URL1,
): DotcompanyLookup {
  return {
    ean: EAN,
    status: 'found',
    raw: {
      gtin: EAN,
      encontrado: true,
      produto: {
        gtin: EAN,
        nome: 'LEITE CONDENSADO MOÇA LATA 395G',
        marca: 'NESTLE',
        imagem_url: url,
      },
    },
    etag: '"v1"',
    fetchedAt: new Date(),
    retryAfter: null,
    galleryImageId: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  } as DotcompanyLookup;
}

function imagem(status = 200, bytes = 1000, type = 'image/webp'): Response {
  return new Response(Buffer.alloc(bytes, 1), { status, headers: { 'content-type': type } });
}

function criar(opts: { existente?: string | null; created?: boolean } = {}) {
  const ds = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('WHERE id = $1')) return opts.existente ? [{ id: opts.existente }] : [];
      if (sql.includes("metadata->>'ean' = $1"))
        return opts.existente ? [{ id: opts.existente }] : [];
      return [];
    }),
  };
  const lookups = {
    now: () => new Date('2026-10-10T12:00:00Z'),
    setGalleryImage: jest.fn(async () => undefined),
    refreshOne: jest.fn(async () => ({ status: 'updated', lookup: lookup({}, URL2) })),
  };
  const builder = {
    build: jest.fn(async (items: Array<{ ean: string }>) =>
      items.map((i) => ({
        title: 'x',
        ean: i.ean,
        eanSource: 'dotcompany',
        eanVerifiedBy: 'exact',
      })),
    ),
  };
  const uploads = {
    uploadFile: jest.fn(async () => ({
      id: 'arq.png',
      url: 'http://cdn/uploads/gallery/arq.png',
      filename: 'x',
      mimeType: 'image/png',
      size: 1,
    })),
    deleteFile: jest.fn(async () => undefined),
  };
  const gallery = {
    registerImportedImage: jest.fn(async () => ({
      image: { id: 'img-1' },
      created: opts.created ?? true,
    })),
    ensureClientPreferred: jest.fn(async () => undefined),
  };
  const svc = new DotcompanyPhotoImporter(
    ds as never,
    lookups as never,
    builder as never,
    uploads as never,
    gallery as never,
  );
  const fetchMock = jest.fn(async () => imagem());
  svc.fetchImpl = fetchMock as never;
  return { svc, lookups, builder, uploads, gallery, fetchMock };
}

describe('DotcompanyPhotoImporter', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('baixa, converte para PNG, salva no bucket e registra na pasta DotCompany', async () => {
    const { svc, uploads, gallery, lookups } = criar();
    const r = await svc.importMany([{ ean: EAN, lookup: lookup() }], {
      kind: 'batch',
      clientIds: ['c1'],
    });

    expect(r.get(EAN)).toEqual({ ean: EAN, status: 'imported', galleryImageId: 'img-1' });
    const [file, folder] = uploads.uploadFile.mock.calls[0] as unknown as [
      Express.Multer.File,
      string,
    ];
    expect(folder).toBe('gallery');
    expect(file.originalname).toBe(`dotcompany-${EAN}.png`);
    expect(file.mimetype).toBe('image/png');
    expect(gallery.registerImportedImage).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://cdn/uploads/gallery/arq.png',
        folderName: DOTCOMPANY_GALLERY_FOLDER,
        clientIds: ['c1'],
        metadata: expect.objectContaining({ ean: EAN, eanSource: 'dotcompany' }),
      }),
    );
    expect(lookups.setGalleryImage).toHaveBeenCalledWith(EAN, 'img-1');
  });

  it('URL vencida (403): reconsulta o EAN e baixa da URL nova', async () => {
    const { svc, fetchMock, lookups } = criar();
    fetchMock.mockResolvedValueOnce(imagem(403)).mockResolvedValueOnce(imagem());
    const r = await svc.importMany([{ ean: EAN, lookup: lookup() }], { kind: 'interactive' });
    expect(lookups.refreshOne).toHaveBeenCalledWith(
      EAN,
      expect.objectContaining({ kind: 'interactive' }),
    );
    expect((fetchMock.mock.calls as unknown as Array<[string]>).map((c) => c[0])).toEqual([
      URL1,
      URL2,
    ]);
    expect(r.get(EAN)?.status).toBe('imported');
  });

  it('URL vencida e a reconsulta não trouxe URL nova: erro (reprocessa na retomada)', async () => {
    const { svc, fetchMock, lookups } = criar();
    fetchMock.mockResolvedValue(imagem(404));
    lookups.refreshOne.mockResolvedValueOnce({ status: 'not_modified', lookup: lookup() });
    const r = await svc.importMany([{ ean: EAN, lookup: lookup() }], { kind: 'batch' });
    expect(r.get(EAN)?.status).toBe('error');
    expect(r.get(EAN)?.reason).toContain('expirada');
  });

  it('imagem maior que 5 MB é recusada', async () => {
    const { svc, fetchMock, uploads } = criar();
    fetchMock.mockResolvedValue(imagem(200, 5 * 1024 * 1024 + 1));
    const r = await svc.importMany([{ ean: EAN, lookup: lookup() }], { kind: 'batch' });
    expect(r.get(EAN)?.status).toBe('error');
    expect(uploads.uploadFile).not.toHaveBeenCalled();
  });

  it('conteúdo que não é imagem é recusado', async () => {
    const { svc, fetchMock } = criar();
    fetchMock.mockResolvedValue(imagem(200, 100, 'text/html'));
    expect(
      (await svc.importMany([{ ean: EAN, lookup: lookup() }], { kind: 'batch' })).get(EAN)?.status,
    ).toBe('error');
  });

  it('sem imagem_url: "sem foto", sem download', async () => {
    const { svc, fetchMock } = criar();
    const r = await svc.importMany([{ ean: EAN, lookup: lookup({}, null) }], { kind: 'batch' });
    expect(r.get(EAN)?.status).toBe('no_image');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('foto DotCompany já na galeria: "já existente", sem baixar, e marca a preferência do cliente', async () => {
    const { svc, fetchMock, gallery } = criar({ existente: 'img-antiga' });
    const r = await svc.importMany(
      [{ ean: EAN, lookup: lookup({ galleryImageId: 'img-antiga' }) }],
      {
        kind: 'batch',
        clientIds: ['c1'],
      },
    );
    expect(r.get(EAN)).toMatchObject({ status: 'already_exists', galleryImageId: 'img-antiga' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gallery.ensureClientPreferred).toHaveBeenCalledWith('img-antiga', ['c1']);
  });

  it('corrida: outro processo importou no meio → apaga o arquivo duplicado', async () => {
    const { svc, uploads } = criar({ created: false });
    const r = await svc.importMany([{ ean: EAN, lookup: lookup() }], { kind: 'batch' });
    expect(r.get(EAN)?.status).toBe('already_exists');
    expect(uploads.deleteFile).toHaveBeenCalledWith('gallery/arq.png');
  });

  it('foto registrada foi apagada da galeria: limpa o vínculo e importa de novo', async () => {
    const { svc, fetchMock, lookups } = criar({ existente: null });
    const r = await svc.importMany([{ ean: EAN, lookup: lookup({ galleryImageId: 'apagada' }) }], {
      kind: 'batch',
    });
    expect(lookups.setGalleryImage).toHaveBeenCalledWith(EAN, null);
    expect(fetchMock).toHaveBeenCalled();
    expect(r.get(EAN)?.status).toBe('imported');
  });
});
