import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { computeTileCrop } from '../domain/mc-tile';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McKitBodyTileService } from './mc-kit-body-tile.service';
import { McStorageService } from './mc-storage.service';

/** sharp REAL sobre identidades sintéticas com alfa: corpo inteiro com cesta, meio corpo, busto. */
describe('McKitBodyTileService — tile de corpo (video-mascote-transparente, D4)', () => {
  jest.setTimeout(60_000);
  let tmpDir: string;
  let saved: Array<Record<string, unknown>>;
  let claimAffected: number;
  let service: McKitBodyTileService;
  let existing: Map<string, Record<string, unknown>>;

  const kit = {
    id: 'kit-1',
    userId: 'u1',
    identityMode: 'generated',
    tileAssetId: 'tile-bust',
    bodyTileAssetId: null,
  } as unknown as McCharacterKit;

  const BASKET = '#F59E0B';
  const svg = (w: number, h: number, inner: string, bg = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${bg}${inner}</svg>`;

  /** 1000×1600, corpo inteiro: cabeça r=200, tronco, pernas até y=1400, braço e cesta à direita. */
  const FULL_BODY = svg(
    1000,
    1600,
    '<circle cx="450" cy="270" r="200" fill="#1E50C8"/>' +
      '<rect x="350" y="470" width="200" height="500" fill="#1E50C8"/>' +
      '<rect x="350" y="970" width="80" height="430" fill="#1E50C8"/>' +
      '<rect x="470" y="970" width="80" height="430" fill="#1E50C8"/>' +
      '<rect x="550" y="600" width="200" height="60" fill="#1E50C8"/>' +
      `<rect x="650" y="640" width="200" height="180" fill="${BASKET}"/>`,
  );
  const FULL_BBOX = { x: 250 / 1000, y: 70 / 1600, w: 400 / 1000, h: 400 / 1600 };
  /** Meio corpo: tronco sai pela borda inferior da imagem. */
  const HALF_BODY = svg(
    1000,
    1600,
    '<circle cx="500" cy="270" r="200" fill="#1E50C8"/>' +
      '<rect x="300" y="470" width="400" height="1130" fill="#1E50C8"/>',
  );
  /** Só busto: cabeça e ombros, cortada embaixo, figura ≤ 2,6 × a altura do rosto. */
  const BUST_ONLY = svg(
    1000,
    1000,
    '<circle cx="500" cy="300" r="200" fill="#1E50C8"/>' +
      '<rect x="150" y="500" width="700" height="500" fill="#1E50C8"/>',
  );
  const BUST_BBOX = { x: 300 / 1000, y: 100 / 1000, w: 400 / 1000, h: 400 / 1000 };
  /** Corpo alto demais: cabeça pequena (r=100) e corpo comprido. */
  const TALL_BODY = svg(
    1000,
    1800,
    '<circle cx="500" cy="200" r="100" fill="#1E50C8"/>' +
      '<rect x="420" y="300" width="160" height="1300" fill="#1E50C8"/>',
  );
  const TALL_BBOX = { x: 400 / 1000, y: 100 / 1800, w: 200 / 1000, h: 200 / 1800 };

  async function identity(name: string, content: string, bbox: object): Promise<void> {
    const dir = path.join(tmpDir, 'commercials', 'kits', 'kit-1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), await sharp(Buffer.from(content)).png().toBuffer());
    existing.set('tile-bust', {
      id: 'tile-bust',
      metadata: { identityAssetId: `id-${name}`, bbox },
    });
    existing.set(`id-${name}`, {
      id: `id-${name}`,
      fileUrl: `/uploads/commercials/kits/kit-1/${name}`,
    });
  }

  async function rasterOf(): Promise<{ data: Buffer; width: number; height: number }> {
    const url = String(saved[0].fileUrl).replace(/^\/uploads\//, '');
    const { data, info } = await sharp(await fs.readFile(path.join(tmpDir, url)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  const alphaAt = (r: { data: Buffer; width: number }, x: number, y: number) =>
    r.data[(y * r.width + x) * 4 + 3];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-body-tile-'));
  });
  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    saved = [];
    existing = new Map();
    claimAffected = 1;
    kit.bodyTileAssetId = null;
    const assetRepo = {
      findOneBy: jest.fn(({ id }: { id: string }) => Promise.resolve(existing.get(id) ?? null)),
      findOneByOrFail: jest.fn(({ id }: { id: string }) => Promise.resolve(existing.get(id))),
      save: jest.fn((obj: Record<string, unknown>) => {
        saved.push(obj);
        return Promise.resolve({ id: 'body-1', ...obj });
      }),
      softDelete: jest.fn(),
      update: jest.fn(),
    };
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn(() => Promise.resolve({ affected: claimAffected })),
    };
    const kitRepo = {
      createQueryBuilder: jest.fn(() => qb),
      findOneByOrFail: jest.fn(() => Promise.resolve({ ...kit, bodyTileAssetId: 'body-other' })),
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) =>
        entity === AnimationAsset ? assetRepo : kitRepo,
      ),
    } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    } as unknown as ConfigService;
    service = new McKitBodyTileService(dataSource, new McStorageService(config));
  });

  it('corpo inteiro com cesta: cabeça, mãos e cesta dentro, bordas de cima e laterais livres, ≥ 720 px', async () => {
    await identity('full.png', FULL_BODY, FULL_BBOX);
    await service.ensure(kit);

    const meta = saved[0].metadata as Record<string, unknown>;
    expect(meta.framing).toBe('body');
    expect(meta.warnings).toEqual([]);
    expect(saved[0]).toEqual(expect.objectContaining({ kind: 'kit_tile', hasAlpha: true }));
    const raster = await rasterOf();
    expect(Math.min(raster.width, raster.height)).toBeGreaterThanOrEqual(720);
    const ratio = raster.width / raster.height;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(1);
    for (let x = 0; x < raster.width; x++) expect(alphaAt(raster, x, 0)).toBe(0);
    for (let y = 0; y < raster.height; y++) {
      expect(alphaAt(raster, 0, y)).toBe(0);
      expect(alphaAt(raster, raster.width - 1, y)).toBe(0);
    }
    // a cesta inteira (cor própria) está no tile: o retângulo de 200×180 → ao menos 20 mil px
    let basket = 0;
    for (let i = 0; i < raster.data.length; i += 4) {
      if (raster.data[i] === 0xf5 && raster.data[i + 1] === 0x9e && raster.data[i + 3] === 255) {
        basket += 1;
      }
    }
    expect(basket).toBeGreaterThan(20_000);
    // a última linha é margem transparente (a identidade não é cortada embaixo)
    expect(meta.cutAtBottom).toBe(false);
    expect(alphaAt(raster, Math.round(raster.width / 2), raster.height - 1)).toBe(0);
  });

  it('meio corpo cortado embaixo: o tile termina no mesmo corte, bordas de cima e laterais livres', async () => {
    await identity('half.png', HALF_BODY, FULL_BBOX);
    await service.ensure(kit);

    const meta = saved[0].metadata as Record<string, unknown>;
    expect(meta.cutAtBottom).toBe(true);
    const raster = await rasterOf();
    expect(alphaAt(raster, Math.round(raster.width / 2), raster.height - 1)).toBe(255);
    for (let x = 0; x < raster.width; x++) expect(alphaAt(raster, x, 0)).toBe(0);
    expect(alphaAt(raster, 0, Math.round(raster.height / 2))).toBe(0);
  });

  it('identidade só de busto: aviso IDENTITY_BUST_ONLY, tile coincide com a personagem, sem geração paga', async () => {
    await identity('bust.png', BUST_ONLY, BUST_BBOX);
    await service.ensure(kit);

    const meta = saved[0].metadata as Record<string, unknown>;
    expect(meta.warnings).toContain('IDENTITY_BUST_ONLY');
    expect(saved).toHaveLength(1); // só o asset do tile; o service não tem provider pago algum
  });

  it('corpo alto demais: encurta por baixo até o rosto ≥ 25%, aviso, cabeça inteira', async () => {
    await identity('tall.png', TALL_BODY, TALL_BBOX);
    await service.ensure(kit);

    const meta = saved[0].metadata as Record<string, unknown>;
    expect(meta.warnings).toContain('BODY_TRIMMED_FOR_FACE');
    expect(meta.faceFraction as number).toBeGreaterThanOrEqual(0.25);
    const raster = await rasterOf();
    // a cabeça (cor sólida) aparece inteira: o círculo de r=100 tem ~31 mil px na escala 1:1
    let head = 0;
    for (let i = 0; i < raster.data.length; i += 4) if (raster.data[i + 3] === 255) head += 1;
    expect(head).toBeGreaterThan(31_000);
  });

  it('fundo em gradiente reprova com 422 BODY_TILE_BORDER_NOT_UNIFORM e ação use_bust', async () => {
    const gradient =
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/>' +
      '<stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="1000" height="1600" fill="url(#g)"/>';
    await identity(
      'grad.png',
      svg(1000, 1600, '<circle cx="500" cy="300" r="200" fill="#fff"/>', gradient),
      FULL_BBOX,
    );
    await expect(service.ensure(kit)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BODY_TILE_BORDER_NOT_UNIFORM',
        details: expect.objectContaining({ actions: ['use_bust'] }),
      }),
    });
    expect(saved).toHaveLength(0);
  });

  it('repetir devolve o tile existente sem recalcular nem gravar', async () => {
    await identity('full.png', FULL_BODY, FULL_BBOX);
    existing.set('body-1', {
      id: 'body-1',
      metadata: { identityAssetId: 'id-full.png', cutoutKey: { chosen: '#00B140' } },
    });
    const withBody = { ...kit, bodyTileAssetId: 'body-1' } as McCharacterKit;
    const result = await service.ensure(withBody);
    expect(result.id).toBe('body-1');
    expect(saved).toHaveLength(0);
  });

  it('perde a corrida das duas abas: descarta o próprio asset e devolve o já gravado', async () => {
    await identity('full.png', FULL_BODY, FULL_BBOX);
    existing.set('body-other', { id: 'body-other', metadata: {} });
    claimAffected = 0;
    const result = await service.ensure(kit);
    expect(result.id).toBe('body-other');
  });

  it('kit sem tile (não aprovado): 422 KIT_NOT_APPROVED', async () => {
    await expect(
      service.ensure({ ...kit, tileAssetId: null } as McCharacterKit),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'KIT_NOT_APPROVED' }),
    });
  });

  it('o tile de busto segue igual (snapshot do plano de recorte)', () => {
    const plan = computeTileCrop({
      width: 1200,
      height: 1600,
      bbox: { x: 280 / 1200, y: 240 / 1600, w: 640 / 1200, h: 640 / 1600 },
    });
    expect(plan).toMatchSnapshot();
  });
});
