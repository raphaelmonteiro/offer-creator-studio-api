import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource, EntityManager } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { Font } from '../../fonts/entities/font.entity';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { pieceCanonicalHash } from '../domain/mc-piece';
import { OfferPieceStillProps } from '../domain/mc-piece-still-props';
import { McStepStatus } from '../domain/mc-state-machines';
import { computeRenderStillHash } from '../domain/mc-step-hashes';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStillRenderer, McStillRendererService } from '../services/mc-still-renderer';
import { McStorageService } from '../services/mc-storage.service';
import { McRenderStillProcessor } from './mc-render-still.processor';

/** Tarefas 6.1/6.2 — consumer do step de projeto `render_still` (fila mc.render). */
describe('McRenderStillProcessor — quadro parado da peça de ofertas', () => {
  let tempRoot: string;
  let uploadsDir: string;
  let project: Record<string, unknown>;
  let fonts: Array<Partial<Font>>;
  let assets: Array<Record<string, unknown>>;
  let previousStill: Record<string, unknown> | null;
  let saved: Array<Record<string, unknown>>;
  let stepUpdates: Array<Record<string, unknown>>;
  let pipeline: Record<string, jest.Mock>;
  let renderer: McStillRenderer & { renderStill: jest.Mock };
  let renderedSize: { width: number; height: number };
  let processor: McRenderStillProcessor;
  const step = {
    id: 'rs-1',
    projectId: 'p1',
    sceneId: null,
    type: McStepType.RENDER_STILL,
    status: McStepStatus.RUNNING,
    phase: 'assembly',
    projectRevision: 1,
    attempt: 1,
  } as unknown as McStep;
  const document = fixturePieceDocument({ texts: [{ text: 'OFERTAS', fontFamily: 'Bebas Neue' }] });

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-still-spec-'));
    uploadsDir = path.join(tempRoot, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    project = {
      id: 'p1',
      userId: 'u1',
      kitId: 'kit-1',
      title: 'Ofertas da semana',
      format: 'offer_piece',
      aspectRatio: '9:16',
      revision: 1,
      pieceId: 'piece-1',
      pieceSnapshot: document,
      options: { musicEnabled: false, captionsEnabled: false, products: [] },
    };
    fonts = [{ family: 'Bebas Neue', fileUrl: '/uploads/fonts/bebas.ttf' }];
    assets = [];
    previousStill = null;
    saved = [];
    stepUpdates = [];
    renderedSize = { width: 1080, height: 1920 };
    pipeline = {
      claimStep: jest.fn().mockResolvedValue(step),
      failStep: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
    };
    renderer = {
      kind: 'mock',
      compositionVersion: jest.fn().mockResolvedValue('0.1.0'),
      renderStill: jest.fn(async (req: { outputPath: string }) => {
        await sharp({
          create: { ...renderedSize, channels: 3, background: '#FFE082' },
        })
          .png()
          .toFile(req.outputPath);
        return { outputPath: req.outputPath, renderer: 'mock', compositionVersion: '0.1.0' };
      }),
    } as unknown as McStillRenderer & { renderStill: jest.Mock };
    const ffmpeg = {
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(tempRoot, 'job-'))),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
    };
    const storage = {
      absoluteFromUrl: jest.fn((url: string) => path.join(uploadsDir, path.basename(url))),
      finalRelDir: jest.fn(
        (u: string, p: string, v: number) => `commercials/${u}/${p}/final/v${v}`,
      ),
      copyFile: jest.fn((src: string, dest: string) => fs.copyFile(src, dest)),
      prepareStreamTarget: jest.fn(async (relDir: string, name: string) => {
        const finalPath = path.join(uploadsDir, name);
        return { partPath: `${finalPath}.part`, finalPath, url: `/uploads/${relDir}/${name}` };
      }),
    };
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(previousStill)),
    };
    const repo = (entity: unknown) => ({
      findOneBy: jest.fn((where: { id: string }) => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === AnimationAsset)
          return Promise.resolve(assets.find((a) => a.id === where.id) ?? null);
        return Promise.resolve(null);
      }),
      find: jest.fn((opts?: { where?: { family?: { _value?: string[] } } }) => {
        if (entity === Font) {
          const families = opts?.where?.family?._value ?? [];
          return Promise.resolve(fonts.filter((f) => families.includes(f.family as string)));
        }
        return Promise.resolve([]);
      }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => qb),
    });
    const dataSource = {
      getRepository: jest.fn(repo),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb({
          getRepository: jest.fn(() => ({
            save: jest.fn((obj: Record<string, unknown>) => {
              const row = { id: 'still-asset', ...obj };
              saved.push(row);
              return Promise.resolve(row);
            }),
          })),
          update: jest.fn((_e: unknown, _w: unknown, patch: Record<string, unknown>) => {
            stepUpdates.push(patch);
            return Promise.resolve({ affected: 1 });
          }),
        } as unknown as EntityManager),
      ),
    };
    processor = new McRenderStillProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      ffmpeg as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
      { current: () => renderer } as unknown as McStillRendererService,
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('renderiza o descritor congelado com as fontes da conta e publica o asset piece_still com hash exato, versão e snapshot', async () => {
    await processor.process({ stepId: 'rs-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(renderer.renderStill).toHaveBeenCalledTimes(1);
    const { props, localFiles } = renderer.renderStill.mock.calls[0][0] as {
      props: OfferPieceStillProps;
      localFiles: Record<string, string>;
    };
    expect(props).toMatchObject({ width: 1080, height: 1920 });
    expect(props.fonts).toEqual([
      { family: 'Bebas Neue', url: 'http://127.0.0.1:3001/uploads/fonts/bebas.ttf' },
    ]);
    expect(localFiles['http://127.0.0.1:3001/uploads/gallery/picanha.png']).toBe(
      path.join(uploadsDir, 'picanha.png'),
    );
    expect(localFiles['http://127.0.0.1:3001/uploads/fonts/bebas.ttf']).toBe(
      path.join(uploadsDir, 'bebas.ttf'),
    );

    const pieceHash = pieceCanonicalHash(document);
    const expectedHash = computeRenderStillHash({
      pieceHash,
      aspectRatio: '9:16',
      compositionVersion: '0.1.0',
      renderer: 'mock',
      fonts: [{ family: 'Bebas Neue', url: '/uploads/fonts/bebas.ttf' }],
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: 'piece_still',
      status: 'ready',
      fileUrl: '/uploads/commercials/u1/p1/final/v1/still.png',
      mimeType: 'image/png',
      width: 1080,
      height: 1920,
      metadata: expect.objectContaining({
        projectId: 'p1',
        version: 1,
        format: 'offer_piece',
        pieceId: 'piece-1',
        pieceHash,
        renderer: 'mock',
        compositionVersion: '0.1.0',
      }),
    });
    const published = await sharp(path.join(uploadsDir, 'still.png')).metadata();
    expect([published.width, published.height]).toEqual([1080, 1920]);
    expect(stepUpdates[0]).toMatchObject({
      inputHash: expectedHash,
      inputSnapshot: expect.objectContaining({ pieceHash, width: 1080, height: 1920 }),
    });
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      step,
      expect.objectContaining({
        outputAssetId: 'still-asset',
        provider: 'mock',
        consumeOnSuccess: true,
      }),
    );
  });

  it('mesmo hash de um quadro anterior com arquivo presente → reaproveita sem renderizar; arquivo sumido → renderiza de novo', async () => {
    await fs.writeFile(path.join(uploadsDir, 'old.png'), Buffer.from('png'));
    assets.push({ id: 'old-still', fileUrl: '/uploads/old.png' });
    previousStill = { id: 'rs-0', outputAssetId: 'old-still' };
    await processor.process({ stepId: 'rs-1' });
    expect(renderer.renderStill).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(stepUpdates[0]).toMatchObject({
      inputSnapshot: expect.objectContaining({ reusedFromStepId: 'rs-0' }),
    });
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      step,
      expect.objectContaining({
        outputAssetId: 'old-still',
        provider: 'cache',
        consumeOnSuccess: false,
      }),
    );
    await fs.rm(path.join(uploadsDir, 'old.png'));
    await processor.process({ stepId: 'rs-1' });
    expect(renderer.renderStill).toHaveBeenCalledTimes(1);
  });

  it('sem pieceSnapshot → falha terminal piece_snapshot_missing sem renderizar; renderizador indisponível → RENDER_UNAVAILABLE', async () => {
    project.pieceSnapshot = null;
    await processor.process({ stepId: 'rs-1' });
    expect(renderer.renderStill).not.toHaveBeenCalled();
    expect(pipeline.failStep).toHaveBeenCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'piece_snapshot_missing' }),
      { fallbackCode: 'still_render_failed' },
    );

    project.pieceSnapshot = document;
    renderer.renderStill.mockRejectedValueOnce(
      new TerminalProviderError('sem composição', 'RENDER_UNAVAILABLE'),
    );
    await processor.process({ stepId: 'rs-1' });
    expect(pipeline.failStep).toHaveBeenLastCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'RENDER_UNAVAILABLE' }),
      { fallbackCode: 'still_render_failed' },
    );
    expect(saved).toHaveLength(0);
  });

  it('quadro fora das dimensões do formato → still_dimensions_mismatch (nada publicado)', async () => {
    renderedSize = { width: 1080, height: 1350 };
    await processor.process({ stepId: 'rs-1' });
    expect(pipeline.failStep).toHaveBeenCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'still_dimensions_mismatch' }),
      { fallbackCode: 'still_render_failed' },
    );
    expect(saved).toHaveLength(0);
    await expect(fs.stat(path.join(uploadsDir, 'still.png'))).rejects.toBeTruthy();
  });

  it('4:5 → props 1080×1350 e quadro na pasta da entrega seguinte (v2 quando já houve um finalize)', async () => {
    project.aspectRatio = '4:5';
    renderedSize = { width: 1080, height: 1350 };
    const dataSource = (processor as unknown as { dataSource: { getRepository: jest.Mock } })
      .dataSource;
    const base = dataSource.getRepository.getMockImplementation() as (
      e: unknown,
    ) => Record<string, jest.Mock>;
    dataSource.getRepository.mockImplementation((entity: unknown) => {
      const repo = base(entity);
      if (entity === McStep) repo.count = jest.fn().mockResolvedValue(1);
      return repo;
    });
    await processor.process({ stepId: 'rs-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(
      (renderer.renderStill.mock.calls[0][0] as { props: OfferPieceStillProps }).props,
    ).toMatchObject({
      width: 1080,
      height: 1350,
    });
    expect(saved[0]).toMatchObject({
      fileUrl: '/uploads/commercials/u1/p1/final/v2/still.png',
      metadata: expect.objectContaining({ version: 2, aspectRatio: '4:5' }),
    });
  });
});
