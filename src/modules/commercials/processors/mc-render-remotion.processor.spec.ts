import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource, EntityManager } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { Mascot } from '../../mascots/entities/mascot.entity';
import { Client } from '../../clients/entities/client.entity';
import { fixtureCarouselScript } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { syntheticAlignment } from '../domain/mc-captions';
import { OfferCarouselProps } from '../domain/mc-offer-carousel-props';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McCarouselRenderer, McCarouselRendererService } from '../services/mc-carousel-renderer';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McRenderRemotionProcessor } from './mc-render-remotion.processor';

/** Tarefa 6.5 — consumer do step de projeto `render_remotion` (fila mc.render). */
describe('McRenderRemotionProcessor — render da composição do F2 (tarefa 6.5)', () => {
  let tempRoot: string;
  let uploadsDir: string;
  let script: McScript;
  let project: Record<string, unknown>;
  let scenes: Array<Record<string, unknown>>;
  let assets: Array<Record<string, unknown>>;
  let previousRender: Record<string, unknown> | null;
  let saved: Array<Record<string, unknown>>;
  let stepUpdates: Array<Record<string, unknown>>;
  let pipeline: Record<string, jest.Mock>;
  let renderer: McCarouselRenderer & { render: jest.Mock };
  let ffmpeg: Record<string, jest.Mock>;
  let processor: McRenderRemotionProcessor;
  const step = {
    id: 'rr-1',
    projectId: 'p1',
    sceneId: null,
    type: McStepType.RENDER_REMOTION,
    status: McStepStatus.RUNNING,
    phase: 'assembly',
    projectRevision: 1,
    attempt: 1,
  } as unknown as McStep;
  const durations = [2000, 2500, 3000, 2200, 1800];

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-render-spec-'));
    uploadsDir = path.join(tempRoot, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    script = fixtureCarouselScript(3);
    project = {
      id: 'p1',
      userId: 'u1',
      kitId: 'k1',
      title: 'Ofertas da semana',
      format: 'offer_carousel',
      aspectRatio: '9:16',
      channel: 'instagram',
      revision: 1,
      layoutPreset: 'character_left',
      options: { musicEnabled: true, captionsEnabled: true, products: [] },
      script,
    };
    scenes = script.scenes.map((s, idx) => ({
      id: `row-${idx}`,
      idx,
      scriptSceneId: s.sceneId,
      status: McSceneStatus.READY,
      durationS: s.durationS,
      finalAssetId: `clip-${idx}`,
      audioAssetId: `au-${idx}`,
      generation: 1,
    }));
    assets = [
      ...scenes.map((s, idx) => ({
        id: `clip-${idx}`,
        fileUrl: `/uploads/c${idx}.mp4`,
        durationMs: durations[idx],
      })),
      ...script.scenes.map((s, idx) => ({
        id: `au-${idx}`,
        fileUrl: `/uploads/a${idx}.mp3`,
        metadata: { alignment: syntheticAlignment(s.dialogue as string, durations[idx] / 1000) },
      })),
      { id: 'tile-1', fileUrl: '/uploads/tile.png', width: 720, height: 960 },
    ];
    previousRender = null;
    saved = [];
    stepUpdates = [];
    pipeline = {
      claimStep: jest.fn().mockResolvedValue(step),
      failStep: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
    };
    renderer = {
      kind: 'mock',
      compositionVersion: jest.fn().mockResolvedValue('0.1.0'),
      render: jest.fn(async (req: { outputPath: string; onProgress?: (p: number) => void }) => {
        await fs.writeFile(req.outputPath, Buffer.from('mp4'));
        await req.onProgress?.(50);
        return { outputPath: req.outputPath, renderer: 'mock', compositionVersion: '0.1.0' };
      }),
    } as unknown as McCarouselRenderer & { render: jest.Mock };
    ffmpeg = {
      probe: jest.fn(async (file: string) => {
        const base = path.basename(file);
        const m = /^c(\d)\.mp4$/.exec(base);
        if (m)
          return {
            hasVideo: true,
            hasAudio: true,
            width: 720,
            height: 960,
            durationMs: durations[Number(m[1])],
          };
        // 5 falas (11,5 s) + 4 silêncios (0,8 s) + cartela 1,5 s = 13,8 s
        return { hasVideo: true, hasAudio: true, width: 1080, height: 1920, durationMs: 13_800 };
      }),
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(tempRoot, 'job-'))),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
      finalizeOutput: jest.fn((part: string, final: string) => fs.rename(part, final)),
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
      getOne: jest.fn(() => Promise.resolve(previousRender)),
    };
    const repo = (entity: unknown) => ({
      findOneBy: jest.fn((where: { id: string }) => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === McCharacterKit)
          return Promise.resolve({
            id: 'k1',
            tileAssetId: 'tile-1',
            tileBackgroundColor: '#ffe082',
            mascotId: 'm1',
            source: 'mascot',
          });
        if (entity === Mascot) return Promise.resolve({ id: 'm1', clientId: 'c1' });
        if (entity === Client)
          return Promise.resolve({ id: 'c1', logoUrl: '/uploads/logos/cliente.png' });
        if (entity === AnimationAsset)
          return Promise.resolve(assets.find((a) => a.id === where.id) ?? null);
        return Promise.resolve(null);
      }),
      find: jest.fn((opts?: { where?: { id?: { _value?: string[] } } }) => {
        if (entity === McScene) return Promise.resolve(scenes);
        if (entity === AnimationAsset) {
          const ids = opts?.where?.id?._value ?? [];
          return Promise.resolve(assets.filter((a) => ids.includes(a.id as string)));
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
              const row = { id: 'rendered-asset', ...obj };
              saved.push(row);
              return Promise.resolve(row);
            }),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
          })),
          update: jest.fn((_e: unknown, _w: unknown, patch: Record<string, unknown>) => {
            stepUpdates.push(patch);
            return Promise.resolve({ affected: 1 });
          }),
        } as unknown as EntityManager),
      ),
    };
    processor = new McRenderRemotionProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      ffmpeg as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
      { current: () => renderer } as unknown as McCarouselRendererService,
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('monta as props pelas falas medidas e publica o vídeo renderizado (commercial_composed) com timeline, hash e versão da composição', async () => {
    await processor.process({ stepId: 'rr-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    const { props, localFiles } = renderer.render.mock.calls[0][0] as {
      props: OfferCarouselProps;
      localFiles: Record<string, string>;
    };
    expect(props.lines.map((l) => [l.startS, l.endS])).toEqual([
      [0, 2],
      [2.2, 4.7],
      [4.9, 7.9],
      [8.1, 10.3],
      [10.5, 12.3],
    ]);
    expect(props.character.clips[0].src).toBe('http://127.0.0.1:3001/uploads/c0.mp4');
    expect(localFiles['http://127.0.0.1:3001/uploads/c0.mp4']).toBe(
      path.join(uploadsDir, 'c0.mp4'),
    );
    expect(props.brand.logoUrl).toBe('http://127.0.0.1:3001/uploads/logos/cliente.png');
    expect(props.character).toMatchObject({ tileRatio: 0.75, backgroundColor: '#FFE082' });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: 'commercial_composed',
      fileUrl: '/uploads/commercials/u1/p1/final/v1/rendered.mp4',
      width: 1080,
      height: 1920,
      metadata: expect.objectContaining({
        format: 'offer_carousel',
        renderer: 'mock',
        compositionVersion: '0.1.0',
        endcard: false,
        captionsRendered: true,
        tailS: 1.5,
        timeline: {
          totalS: 12.3,
          scenes: expect.arrayContaining([
            expect.objectContaining({
              sceneId: script.scenes[1].sceneId,
              idx: 1,
              finalAssetId: 'clip-1',
              startS: 2.2,
              endS: 4.7,
            }),
          ]),
        },
      }),
    });
    const hash = (saved[0].metadata as { propsHash: string }).propsHash;
    expect(stepUpdates[0]).toMatchObject({
      inputHash: hash,
      inputSnapshot: expect.objectContaining({ propsHash: hash }),
    });
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      step,
      expect.objectContaining({ outputAssetId: 'rendered-asset', provider: 'mock' }),
    );
  });

  it('mesmo hash de um render anterior com arquivo presente → reaproveita sem renderizar de novo', async () => {
    await fs.writeFile(path.join(uploadsDir, 'old.mp4'), Buffer.from('mp4'));
    assets.push({ id: 'old-render', fileUrl: '/uploads/old.mp4' });
    previousRender = { id: 'rr-0', outputAssetId: 'old-render' };
    await processor.process({ stepId: 'rr-1' });
    expect(renderer.render).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(stepUpdates[0]).toMatchObject({
      inputSnapshot: expect.objectContaining({ reusedFromStepId: 'rr-0' }),
    });
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      step,
      expect.objectContaining({ outputAssetId: 'old-render', provider: 'cache' }),
    );
    // arquivo do render antigo sumiu do disco → renderiza de novo
    previousRender = { id: 'rr-0', outputAssetId: 'old-render' };
    await fs.rm(path.join(uploadsDir, 'old.mp4'));
    await processor.process({ stepId: 'rr-1' });
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('renderizador indisponível → falha TERMINAL RENDER_UNAVAILABLE pelo failStep (needs_attention, retomada da montagem)', async () => {
    renderer.render.mockRejectedValueOnce(
      new TerminalProviderError('sem pacote', 'RENDER_UNAVAILABLE'),
    );
    await processor.process({ stepId: 'rr-1' });
    expect(pipeline.failStep).toHaveBeenCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'RENDER_UNAVAILABLE' }),
      { fallbackCode: 'render_failed' },
    );
    expect(saved).toHaveLength(0);
  });

  it('dados fora do contrato (oferta sem foto) → falha terminal OFFER_IMAGE_REQUIRED sem chamar o renderizador; duração errada → render_duration_mismatch', async () => {
    project.script = {
      ...script,
      offers: script.offers?.map((o, i) => (i === 0 ? { ...o, imageUrl: null } : o)),
    };
    await processor.process({ stepId: 'rr-1' });
    expect(renderer.render).not.toHaveBeenCalled();
    expect(pipeline.failStep.mock.calls[0][2]).toMatchObject({ code: 'OFFER_IMAGE_REQUIRED' });

    project.script = script;
    ffmpeg.probe.mockImplementation(async (file: string) =>
      /^c\d\.mp4$/.test(path.basename(file))
        ? { hasVideo: true, hasAudio: true, width: 720, height: 960, durationMs: 2000 }
        : { hasVideo: true, hasAudio: true, width: 1080, height: 1920, durationMs: 4000 },
    );
    await processor.process({ stepId: 'rr-1' });
    expect(pipeline.failStep.mock.calls[1][2]).toMatchObject({ code: 'render_duration_mismatch' });
  });

  it('cena ainda não pronta (re-roll no meio) → step cancelado em silêncio (composition_changed)', async () => {
    scenes[2].status = McSceneStatus.PENDING;
    await processor.process({ stepId: 'rr-1' });
    expect(renderer.render).not.toHaveBeenCalled();
    expect(pipeline.failStep).not.toHaveBeenCalled();
  });
});
