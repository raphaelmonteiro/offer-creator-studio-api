import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { BackgroundRemovalService } from '../ai/background-removal.service';
import { UploadsService } from '../uploads/uploads.service';
import { Mascot } from './entities/mascot.entity';
import { MascotsService } from './mascots.service';
import { MascotRigService } from './services/mascot-rig.service';

/**
 * Logo como personagem de origem (change video-formatos-personagem, D5):
 * `createFromUrl` copia o `clients.logoUrl` para uma linha de `mascots` com
 * `kind = 'logo'`; o upload aceita `kind`. Sem banco: repo mockado; sharp real
 * (é o mesmo binário do produto) sobre PNG/JPEG sintéticos.
 */
describe('MascotsService — logo como personagem de origem (D5)', () => {
  let tmpDir: string;
  let saved: Array<Record<string, unknown>>;
  let repo: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock };
  let uploads: { uploadFile: jest.Mock };
  let service: MascotsService;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mascots-url-'));
    await fs.mkdir(path.join(tmpDir, 'logos'), { recursive: true });
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48">' +
        '<rect width="64" height="48" fill="#ff0000"/></svg>',
    );
    await fs.writeFile(path.join(tmpDir, 'logos', 'logo.png'), await sharp(svg).png().toBuffer());
    await fs.writeFile(path.join(tmpDir, 'logos', 'logo.jpg'), await sharp(svg).jpeg().toBuffer());
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    saved = [];
    repo = {
      create: jest.fn((obj: Record<string, unknown>) => ({ ...obj })),
      save: jest.fn(async (obj: Record<string, unknown>) => {
        const row = { id: obj.id ?? `m-${saved.length + 1}`, ...obj };
        saved.push(row);
        return row;
      }),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };
    uploads = {
      uploadFile: jest.fn(async (file: Express.Multer.File, folder: string) => ({
        id: file.originalname,
        url: `http://cdn/uploads/${folder}/${file.originalname}`,
      })),
    };
    const config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    };
    service = new MascotsService(
      repo as unknown as Repository<Mascot>,
      uploads as unknown as UploadsService,
      {} as BackgroundRemovalService,
      {} as MascotRigService,
      config as unknown as ConfigService,
    );
  });

  it('copia o logo do cliente para a pasta de mascotes como kind logo, vinculado ao cliente, com direitos', async () => {
    const view = await service.createFromUrl('u1', 'http://cdn/uploads/logos/logo.png', {
      name: 'Logo Mercado Bom',
      clientId: 'c1',
      kind: 'logo',
      rightsConfirmed: true,
    });
    // fonte copiada (o arquivo do cliente não é tocado) + preview derivado
    const folders = uploads.uploadFile.mock.calls.map((c) => c[1]);
    expect(folders.every((f) => f === 'mascots')).toBe(true);
    expect(view).toMatchObject({
      kind: 'logo',
      clientId: 'c1',
      name: 'Logo Mercado Bom',
      width: 64,
      height: 48,
      rightsConfirmedBy: 'u1',
    });
    expect(view.rightsConfirmedAt).toBeInstanceOf(Date);
    expect(view.sourceImageUrl).toMatch(/\/uploads\/mascots\/logo\.png$/);
    expect(view.metadata).toMatchObject({
      sourceUrl: 'http://cdn/uploads/logos/logo.png',
      importedFrom: 'url',
    });
  });

  it('JPEG vira PNG (mesma regra de aceite do upload: PNG/WebP)', async () => {
    const view = await service.createFromUrl('u1', '/uploads/logos/logo.jpg', {
      name: 'Logo',
      kind: 'logo',
    });
    const [file] = uploads.uploadFile.mock.calls[0] as [Express.Multer.File];
    expect(file.mimetype).toBe('image/png');
    expect((await sharp(file.buffer).metadata()).format).toBe('png');
    expect(view.sourceImageUrl).toMatch(/logo\.png$/);
    expect(view.rightsConfirmedAt).toBeNull();
  });

  it('é idempotente por URL: segunda chamada devolve a linha existente e confirma direitos se pedido agora', async () => {
    const existing = {
      id: 'm-logo',
      userId: 'u1',
      kind: 'logo',
      clientId: 'c1',
      rightsConfirmedAt: null,
      cutoutUrl: '/uploads/mascots/x.png',
      metadata: { sourceUrl: 'http://cdn/uploads/logos/logo.png' },
      rig: {},
      status: 'draft',
    };
    repo.find.mockResolvedValue([existing]);
    repo.findOne.mockResolvedValue({ ...existing });

    const same = await service.createFromUrl('u1', 'http://cdn/uploads/logos/logo.png', {
      name: 'Logo',
      clientId: 'c1',
      kind: 'logo',
    });
    expect(same.id).toBe('m-logo');
    expect(uploads.uploadFile).not.toHaveBeenCalled();

    const confirmed = await service.createFromUrl('u1', 'http://cdn/uploads/logos/logo.png', {
      name: 'Logo',
      clientId: 'c1',
      kind: 'logo',
      rightsConfirmed: true,
    });
    expect(confirmed.id).toBe('m-logo');
    expect(confirmed.rightsConfirmedAt).toBeInstanceOf(Date);
    expect(uploads.uploadFile).not.toHaveBeenCalled();
  });

  it('arquivo de origem ausente no bucket → 422 SOURCE_IMAGE_MISSING', async () => {
    await expect(
      service.createFromUrl('u1', '/uploads/logos/nao-existe.png', { name: 'Logo', kind: 'logo' }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'SOURCE_IMAGE_MISSING' } });
    expect(repo.save).not.toHaveBeenCalled();
  });

  describe('upload com kind', () => {
    const png = () =>
      sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00f"/></svg>',
        ),
      )
        .png()
        .toBuffer();

    it('kind logo é aceito e gravado; ausente vira mascot', async () => {
      const buffer = await png();
      const file = {
        buffer,
        size: buffer.length,
        mimetype: 'image/png',
        originalname: 'a.png',
      } as Express.Multer.File;
      const logo = await service.create('u1', file, { name: 'Marca', kind: 'logo' });
      expect(logo.kind).toBe('logo');
      const mascot = await service.create('u1', file, { name: 'Zé' });
      expect(mascot.kind).toBe('mascot');
    });

    it('kind fora do vocabulário → 400 INVALID_MASCOT_KIND', async () => {
      const buffer = await png();
      const file = {
        buffer,
        size: buffer.length,
        mimetype: 'image/png',
        originalname: 'a.png',
      } as Express.Multer.File;
      await expect(
        service.create('u1', file, { name: 'Marca', kind: 'sticker' }),
      ).rejects.toMatchObject({ status: 400, response: { code: 'INVALID_MASCOT_KIND' } });
    });
  });
});

/** Correções da revisão (change video-formatos-personagem): teto por `stat` e lista por tipo. */
describe('MascotsService — teto de tamanho antes da leitura e lista por tipo', () => {
  let tmpDir: string;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
  };
  let uploads: { uploadFile: jest.Mock };
  let service: MascotsService;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mascots-cap-'));
    await fs.mkdir(path.join(tmpDir, 'logos'), { recursive: true });
    // arquivo esparso de 10 MB + 1 byte: ocupa quase nada no disco, mas o stat vê o tamanho
    const handle = await fs.open(path.join(tmpDir, 'logos', 'huge.png'), 'w');
    await handle.truncate(10 * 1024 * 1024 + 1);
    await handle.close();
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    repo = {
      create: jest.fn((obj: Record<string, unknown>) => ({ ...obj })),
      save: jest.fn(async (obj: Record<string, unknown>) => ({ id: 'm-1', ...obj })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    uploads = { uploadFile: jest.fn() };
    const config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    };
    service = new MascotsService(
      repo as unknown as Repository<Mascot>,
      uploads as unknown as UploadsService,
      {} as BackgroundRemovalService,
      {} as MascotRigService,
      config as unknown as ConfigService,
    );
  });

  it('imagem de origem acima de 10 MB → 422 SOURCE_IMAGE_TOO_LARGE pelo stat, sem ler o arquivo', async () => {
    const readSpy = jest.spyOn(fs, 'readFile');
    await expect(
      service.createFromUrl('u1', '/uploads/logos/huge.png', { name: 'Logo', kind: 'logo' }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'SOURCE_IMAGE_TOO_LARGE' } });
    expect(readSpy).not.toHaveBeenCalled();
    expect(uploads.uploadFile).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it('findAll lista só mascotes por padrão; kind=logo filtra logos; kind=all lista os dois', async () => {
    await service.findAll('u1', {});
    expect(repo.findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1', kind: 'mascot' }) }),
    );
    await service.findAll('u1', { kind: 'logo' });
    expect(repo.findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: 'logo' }) }),
    );
    await service.findAll('u1', { kind: 'all' });
    const where = (repo.findAndCount.mock.calls[2][0] as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty('kind');
  });
});
