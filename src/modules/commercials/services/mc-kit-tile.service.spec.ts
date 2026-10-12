import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { MC_TILE_MIN_RATIO, MC_TILE_MIN_SHORT_SIDE } from '../domain/mc-tile';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McKitTileService } from './mc-kit-tile.service';
import { McStorageService } from './mc-storage.service';

/**
 * sharp REAL (é o binário do produto) sobre PNGs sintéticos: um personagem
 * com cabeça redonda na caixa do gate e corpo saindo por baixo, um logo
 * transparente e um fundo em gradiente (reprovado).
 */
describe('McKitTileService — tile do personagem na aprovação (D1)', () => {
  let tmpDir: string;
  let assetRepo: { save: jest.Mock };
  let service: McKitTileService;

  const kit = {
    id: 'kit-1',
    userId: 'u1',
    identityMode: 'generated',
    tileBackgroundColor: null,
  } as unknown as McCharacterKit;

  async function writePng(name: string, svg: string): Promise<AnimationAsset> {
    const dir = path.join(tmpDir, 'commercials', 'kits', 'kit-1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), await sharp(Buffer.from(svg)).png().toBuffer());
    return {
      id: `asset-${name}`,
      fileUrl: `/uploads/commercials/kits/kit-1/${name}`,
    } as AnimationAsset;
  }

  /** 1200×1600: fundo cinza, cabeça (círculo) e corpo até a borda inferior. */
  const CHARACTER_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600">' +
    '<rect width="1200" height="1600" fill="#E5E7EB"/>' +
    '<rect x="400" y="850" width="400" height="750" fill="#1E50C8"/>' +
    '<circle cx="600" cy="560" r="320" fill="#1E50C8"/>' +
    '</svg>';
  /** Caixa do rosto correspondente ao círculo acima (280..920 × 240..880). */
  const FACE_BBOX = { x: 280 / 1200, y: 240 / 1600, w: 640 / 1200, h: 640 / 1600 };

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-kit-tile-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    assetRepo = {
      save: jest.fn((obj: Record<string, unknown>) => Promise.resolve({ id: 'tile-1', ...obj })),
    };
    const dataSource = { getRepository: jest.fn(() => assetRepo) } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    } as unknown as ConfigService;
    service = new McKitTileService(dataSource, new McStorageService(config));
  });

  it('recorta pela caixa do rosto: rosto ≥ 60% da altura, 3:4..1:1, ≥ 720 px, fundo detectado', async () => {
    const identity = await writePng('identity.png', CHARACTER_SVG);
    const result = await service.build(kit, identity, FACE_BBOX);

    expect(result.faceFraction).toBeGreaterThanOrEqual(0.6);
    expect(result.ratio).toBeGreaterThanOrEqual(MC_TILE_MIN_RATIO);
    expect(result.ratio).toBeLessThanOrEqual(1);
    expect(Math.min(result.width, result.height)).toBeGreaterThanOrEqual(MC_TILE_MIN_SHORT_SIDE);
    expect(result.backgroundColor).toBe('#E5E7EB');
    expect(result.hasAlpha).toBe(false);

    // o PNG gravado tem exatamente as dimensões planejadas
    const file = await fs.readFile(path.join(tmpDir, result.url.replace(/^\/uploads\//, '')));
    const meta = await sharp(file).metadata();
    expect([meta.width, meta.height]).toEqual([result.width, result.height]);

    expect(assetRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'kit_tile',
        status: 'ready',
        userId: 'u1',
        origin: 'ai_generated',
        metadata: expect.objectContaining({
          kitId: 'kit-1',
          identityAssetId: 'asset-identity.png',
          backgroundColor: '#E5E7EB',
        }),
      }),
    );
    expect(result.assetId).toBe('tile-1');
  });

  it('identidade pequena (512 px, como a referência mock) é ampliada até 720 no lado menor', async () => {
    const identity = await writePng(
      'small.png',
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">' +
        '<rect width="512" height="512" fill="#4F86C6"/>' +
        '<circle cx="256" cy="210" r="100" fill="#ffffff"/></svg>',
    );
    const result = await service.build(kit, identity, { x: 0.3, y: 0.2, w: 0.4, h: 0.4 });
    expect(Math.min(result.width, result.height)).toBe(MC_TILE_MIN_SHORT_SIDE);
    expect(result.backgroundColor).toBe('#4F86C6');
  });

  it('logo como está: recorte dos pixels ORIGINAIS, alfa preservado, fundo = cor dominante (logo transparente)', async () => {
    const identity = await writePng(
      'logo.png',
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">' +
        '<rect x="100" y="80" width="400" height="240" fill="#FF0000"/></svg>',
    );
    const logoKit = { ...kit, identityMode: 'logo_as_is' } as McCharacterKit;
    const result = await service.build(logoKit, identity, null);

    // 600×400 → 1:1 (600×600) → escala 1,2 → 720×720
    expect([result.width, result.height]).toEqual([720, 720]);
    expect(result.hasAlpha).toBe(true);
    expect(result.backgroundColor).toBe('#FF0000');
    expect(result.faceFraction).toBeNull();

    const file = await fs.readFile(path.join(tmpDir, result.url.replace(/^\/uploads\//, '')));
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    // centro do retângulo vermelho (pixels originais, não regenerados)
    const center = (360 * info.width + 360) * 4;
    expect([data[center], data[center + 1], data[center + 2], data[center + 3]]).toEqual([
      255, 0, 0, 255,
    ]);
    // faixa estendida (acima do logo) continua transparente
    const pad = (30 * info.width + 360) * 4;
    expect(data[pad + 3]).toBe(0);
    expect(assetRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'kit_tile', origin: 'imported', hasAlpha: true }),
    );
  });

  it('logo como está: caixa do rosto que corta o logo cai para o logo inteiro (pixels originais, borda do próprio logo)', async () => {
    const identity = await writePng(
      'logo-wordmark.png',
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">' +
        '<rect width="600" height="600" fill="#FFFFFF"/>' +
        '<circle cx="300" cy="300" r="200" fill="#D32F2F"/></svg>',
    );
    const logoKit = { ...kit, identityMode: 'logo_as_is' } as McCharacterKit;
    // caixa "do rosto" no meio do círculo: o recorte cortaria a marca → logo inteiro
    const result = await service.build(logoKit, identity, { x: 0.3, y: 0.15, w: 0.4, h: 0.4 });
    expect([result.width, result.height]).toEqual([720, 720]);
    expect(result.faceFraction).toBeNull();
    expect(result.backgroundColor).toBe('#FFFFFF');
    // identidade GERADA não tem esse fallback: o recorte sujo é recusado
    await expect(
      service.build(kit, identity, { x: 0.3, y: 0.15, w: 0.4, h: 0.4 }),
    ).rejects.toMatchObject({ response: { code: 'TILE_BORDER_NOT_UNIFORM' } });
  });

  it('cor pedida no kit vence a detectada em identidade gerada', async () => {
    const identity = await writePng('identity-color.png', CHARACTER_SVG);
    const result = await service.build(
      { ...kit, tileBackgroundColor: '#ABCDEF' } as McCharacterKit,
      identity,
      FACE_BBOX,
    );
    expect(result.backgroundColor).toBe('#ABCDEF');
  });

  it('borda não uniforme (gradiente atrás do personagem) → 422 TILE_BORDER_NOT_UNIFORM, nada gravado', async () => {
    const identity = await writePng(
      'gradient.png',
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600">' +
        '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#000"/>' +
        '<stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
        '<rect width="1200" height="1600" fill="url(#g)"/>' +
        '<circle cx="600" cy="560" r="320" fill="#1E50C8"/></svg>',
    );
    await expect(service.build(kit, identity, FACE_BBOX)).rejects.toMatchObject({
      status: 422,
      response: { code: 'TILE_BORDER_NOT_UNIFORM' },
    });
    expect(assetRepo.save).not.toHaveBeenCalled();
  });

  it('arquivo da identidade ausente → 422 KIT_IDENTITY_FILE_MISSING', async () => {
    await expect(
      service.build(
        kit,
        { id: 'x', fileUrl: '/uploads/commercials/kits/kit-1/nao-existe.png' } as AnimationAsset,
        null,
      ),
    ).rejects.toMatchObject({ status: 422, response: { code: 'KIT_IDENTITY_FILE_MISSING' } });
  });
});
