import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  GEMINI_VISION_MODEL,
  GeminiImageProvider,
} from '../../../shared/providers/gemini-image.provider';
import { TransientProviderError } from '../../../shared/providers/provider-errors';
import { MC_PRICE_DETECT_PROMPT, MC_PRICE_DETECT_VERSION } from '../domain/mc-price-detect';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McStorageService } from './mc-storage.service';
import { McWindowPriceService } from './mc-window-price.service';

/**
 * Aviso "janela sobre preço" (tarefa 4.7): detecção mockada (overlap / sem
 * preço), visão real mockada (resposta e indisponibilidade), cache das
 * detecções no asset da arte e a regra de nunca bloquear nem lançar.
 */
describe('McWindowPriceService — janela sobre preço (4.7)', () => {
  const env = {
    provider: process.env.MC_KIT_PROVIDER,
    mock: process.env.MC_PRICE_DETECT_MOCK,
  };
  let artPng: Buffer;
  let project: Record<string, unknown>;
  let art: Record<string, unknown>;
  let queries: Array<{ sql: string; params: unknown[] }>;
  let gemini: { describeImages: jest.Mock };
  let storage: { readUploadsFile: jest.Mock };
  let service: McWindowPriceService;

  beforeAll(async () => {
    artPng = await sharp({
      create: { width: 1080, height: 1350, channels: 3, background: '#F4EBD0' },
    })
      .png()
      .toBuffer();
  });

  beforeEach(() => {
    process.env.MC_KIT_PROVIDER = 'mock';
    process.env.MC_PRICE_DETECT_MOCK = 'overlap';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    project = {
      id: 'p1',
      userId: 'u1',
      kitId: 'k1',
      format: 'talking_art',
      aspectRatio: '4:5',
      backgroundArtAssetId: 'art1',
      script: null, // janela default: canto inferior direito
    };
    art = {
      id: 'art1',
      kind: 'video_art',
      fileUrl: '/uploads/commercials/art/u1/art.png',
      width: 1080,
      height: 1350,
      metadata: { aspectRatio: '4:5' },
    };
    queries = [];
    gemini = { describeImages: jest.fn() };
    storage = { readUploadsFile: jest.fn().mockResolvedValue(artPng) };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(({ id }: { id: string }) => {
          if (entity === McProject) return Promise.resolve(id === 'p1' ? project : null);
          if (entity === McCharacterKit) return Promise.resolve({ id: 'k1', tileAssetId: 'tile1' });
          if (entity === AnimationAsset) {
            if (id === 'art1') return Promise.resolve(art);
            if (id === 'tile1') return Promise.resolve({ id: 'tile1', width: 720, height: 960 });
          }
          return Promise.resolve(null);
        }),
      })),
      query: jest.fn((sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return Promise.resolve([]);
      }),
    };
    service = new McWindowPriceService(
      dataSource as unknown as DataSource,
      gemini as unknown as GeminiImageProvider,
      storage as unknown as McStorageService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('MC_KIT_PROVIDER', env.provider);
    restore('MC_PRICE_DETECT_MOCK', env.mock);
  });

  const cacheWrites = () => queries.filter((q) => q.sql.includes('priceDetections'));

  it('mock overlap: janela default cobre o preço → WINDOW_COVERS_PRICE com a caixa e presets livres; detecções gravadas no asset', async () => {
    const view = await service.checkOwned('u1', 'p1');
    expect(view.error).toBeUndefined();
    expect(view.warnings).toEqual([
      {
        code: 'WINDOW_COVERS_PRICE',
        box: { x: 0.5796, y: 0.4504, w: 0.3796, h: 0.3496 },
        text: 'R$ 9,99',
        message: expect.stringContaining('cobre um preço'),
        suggestedPresetIds: expect.arrayContaining(['top_left', 'bottom_left']),
      },
    ]);
    expect(view.warnings[0].suggestedPresetIds).not.toContain('bottom_right');
    expect(view).toMatchObject({
      frame: { width: 1080, height: 1350 },
      detections: 1, // o título da arte não é preço
      cached: false,
      model: 'mock:overlap',
      mock: true,
    });
    // a visão nunca é chamada no mock; a arte é lida (caminho de arquivo exercitado)
    expect(gemini.describeImages).not.toHaveBeenCalled();
    expect(storage.readUploadsFile).toHaveBeenCalledWith('/uploads/commercials/art/u1/art.png');
    expect(cacheWrites()).toHaveLength(1);
    const [assetId, json] = cacheWrites()[0].params as [string, string];
    expect(assetId).toBe('art1');
    expect(JSON.parse(json)).toMatchObject({
      version: MC_PRICE_DETECT_VERSION,
      model: 'mock:overlap',
      detections: [
        { text: 'R$ 9,99', bbox: { x: 0.58, y: 0.45, w: 0.38, h: 0.35 }, kind: 'price' },
        { text: 'OFERTAS DA SEMANA', kind: 'text' },
      ],
    });
  });

  it('janela num preset livre (canto superior esquerdo) → sem aviso', async () => {
    project.script = { window: { x: 0.0602, y: 0.0482, w: 0.3558, h: 0.3795 } };
    const view = await service.check(project as unknown as McProject);
    expect(view.warnings).toEqual([]);
    expect(view.detections).toBe(1);
    expect(view.window).toEqual({ x: 0.0602, y: 0.0482, w: 0.3558, h: 0.3795 });
  });

  it('mock none: arte sem preço → sem aviso', async () => {
    process.env.MC_PRICE_DETECT_MOCK = 'none';
    const view = await service.check(project as unknown as McProject);
    expect(view).toMatchObject({ warnings: [], detections: 0, model: 'mock:none' });
  });

  it('cache por arte: detecções gravadas com a mesma versão/modelo são reutilizadas sem ler a arte nem gravar de novo', async () => {
    art.metadata = {
      aspectRatio: '4:5',
      priceDetections: {
        version: MC_PRICE_DETECT_VERSION,
        model: 'mock:overlap',
        at: '2026-10-12T10:00:00.000Z',
        detections: [
          { text: 'R$ 9,99', bbox: { x: 0.58, y: 0.45, w: 0.38, h: 0.35 }, kind: 'price' },
        ],
      },
    };
    const view = await service.check(project as unknown as McProject);
    expect(view).toMatchObject({ cached: true, at: '2026-10-12T10:00:00.000Z' });
    expect(view.warnings).toHaveLength(1);
    expect(storage.readUploadsFile).not.toHaveBeenCalled();
    expect(cacheWrites()).toHaveLength(0);
    // modelo diferente (mock none) invalida o cache
    process.env.MC_PRICE_DETECT_MOCK = 'none';
    const fresh = await service.check(project as unknown as McProject);
    expect(fresh).toMatchObject({ cached: false, warnings: [], model: 'mock:none' });
    expect(cacheWrites()).toHaveLength(1);
  });

  it('visão real: Gemini recebe a arte e o prompt de preços; caixas 0–1000 viram o aviso', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    gemini.describeImages.mockResolvedValue(
      '{"prices": [{"text": "R$ 12,90", "box_2d": [600, 600, 900, 950], "confidence": 0.9}]}',
    );
    const view = await service.check(project as unknown as McProject);
    expect(gemini.describeImages).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: MC_PRICE_DETECT_PROMPT, mimeType: 'image/png' }),
    );
    const sent = gemini.describeImages.mock.calls[0][0].images[0] as Buffer;
    expect((await sharp(sent).metadata()).height).toBeLessThanOrEqual(1536);
    expect(view).toMatchObject({ model: GEMINI_VISION_MODEL, cached: false, detections: 1 });
    expect(view.warnings).toEqual([expect.objectContaining({ text: 'R$ 12,90' })]);
    expect(view).not.toHaveProperty('mock');
  });

  it('indisponibilidade (visão fora): avisos vazios + error, sem lançar e sem gravar cache', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    gemini.describeImages.mockRejectedValue(new TransientProviderError('HTTP 503'));
    const view = await service.checkOwned('u1', 'p1');
    expect(view).toEqual({
      projectId: 'p1',
      warnings: [],
      error: 'HTTP 503',
      model: GEMINI_VISION_MODEL,
    });
    expect(cacheWrites()).toHaveLength(0);
  });

  it('resposta ilegível, mock error e arte ausente no disco também viram error (nunca exceção)', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    gemini.describeImages.mockResolvedValue('não sei');
    expect((await service.check(project as unknown as McProject)).error).toMatch(
      /não interpretável/,
    );
    process.env.MC_KIT_PROVIDER = 'mock';
    process.env.MC_PRICE_DETECT_MOCK = 'error';
    expect(await service.check(project as unknown as McProject)).toMatchObject({
      warnings: [],
      error: expect.stringContaining('indisponível'),
    });
    process.env.MC_PRICE_DETECT_MOCK = 'overlap';
    storage.readUploadsFile.mockResolvedValue(null);
    expect((await service.check(project as unknown as McProject)).error).toMatch(/ausente/);
  });

  it('falha ao gravar o cache não derruba o aviso', async () => {
    (service as unknown as { dataSource: { query: jest.Mock } }).dataSource.query = jest
      .fn()
      .mockRejectedValue(new Error('deadlock'));
    const view = await service.check(project as unknown as McProject);
    expect(view.warnings).toHaveLength(1);
    expect(view.error).toBeUndefined();
  });

  it('não se aplica: outro formato, projeto sem arte, modo rosto do logo', async () => {
    expect(await service.check({ ...project, format: 'scenes' } as unknown as McProject)).toEqual({
      projectId: 'p1',
      warnings: [],
      skipped: 'not_talking_art',
    });
    expect(
      await service.check({ ...project, backgroundArtAssetId: null } as unknown as McProject),
    ).toEqual({ projectId: 'p1', warnings: [], skipped: 'no_art' });
    expect(
      await service.check({ ...project, script: { logoFace: true } } as unknown as McProject),
    ).toEqual({ projectId: 'p1', warnings: [], skipped: 'logo_face' });
  });

  it('ownership: projeto inexistente → 404; de outro usuário → 403', async () => {
    await expect(service.checkOwned('u1', 'p-x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.checkOwned('u2', 'p1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
