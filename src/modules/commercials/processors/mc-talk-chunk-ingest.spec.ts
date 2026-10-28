import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McStepStatus } from '../domain/mc-state-machines';
import { buildChunkTalkStep, ChunkSnapshot, readChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { planTalkChunks } from '../domain/mc-talk-chunks';
import { KLING_AVATAR_MODEL } from '../domain/mc-pipeline.config';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McProject } from '../entities/mc-project.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { ChunkIngestHelpers, McTalkChunkIngest } from './mc-talk-chunk-ingest';

/**
 * Ingest do `talk` de trecho (change video-fala-continua, 1.4): conformar + fatiar num passe, inspeção
 * única, uma fatia por cena, custo só na líder, seguidoras `ready` na mesma transação do step.
 */
describe('McTalkChunkIngest', () => {
  const durations = [2168, 1907, 4310];
  let tempDir: string;
  let ffmpegRuns: string[][];
  let saved: Array<Record<string, unknown>>;
  let pipeline: { markChunkSceneReady: jest.Mock; completeStepAndAdvance: jest.Mock };
  let helpers: { [K in keyof ChunkIngestHelpers]: jest.Mock };
  let ingest: McTalkChunkIngest;
  let chunk: ChunkSnapshot;
  let step: McStep;
  let probeMs: Record<string, number>;
  let emptyPng = false;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-chunk-ingest-'));
    const plan = planTalkChunks({
      speeches: durations.map((durationMs, i) => ({ sceneId: `row-${i}`, durationMs })),
      engineModel: KLING_AVATAR_MODEL,
      engineMaxChunkS: 15,
      chunkMaxS: 10,
    }).chunks[0];
    const built = buildChunkTalkStep({
      ctx: {
        tileAssetId: 'a-tile',
        tileWidth: 720,
        tileHeight: 960,
        backgroundColor: '#FFFFFF',
        cutout: null,
        tier: 'economico',
        identityMode: 'generated',
        engine: {
          key: 'economico',
          model: KLING_AVATAR_MODEL,
          usdPerSecond: 0.0562,
          maxChunkS: 15,
        },
      },
      chunk: plan,
      speeches: durations.map((_d, i) => ({
        sceneRowId: `row-${i}`,
        sceneId: `s${i}`,
        audioAssetId: `a-tts-${i}`,
      })),
      join: null,
      motion: '',
      lang: 'pt',
      sceneType: 'talk_tile',
      attempt: 1,
      count: 1,
    });
    chunk = readChunkSnapshot(built.snapshot)!;
    step = {
      id: 'st-chunk',
      projectId: 'p1',
      sceneId: 'row-0',
      sceneGeneration: 1,
      type: 'talk',
      status: McStepStatus.INGESTING,
      attempts: 1,
      provider: KLING_AVATAR_MODEL,
      providerJobId: 'req-1',
      inputSnapshot: built.snapshot,
    } as unknown as McStep;
    ffmpegRuns = [];
    saved = [];
    probeMs = {};
    emptyPng = false;
    const ffmpeg = {
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(os.tmpdir(), 'mc-chunk-ingest-aux-'))),
      removeTempDir: jest.fn((dir: string) => fs.rm(dir, { recursive: true, force: true })),
      run: jest.fn(async (args: string[]) => {
        ffmpegRuns.push(args);
        // cada saída .mp4/.wav/.jpg do comando é criada (o ffmpeg real escreveria)
        for (const arg of args) {
          if (/\.(mp4|wav|mp3|jpg|png)$/.test(arg) && !arg.includes('raw')) {
            await fs.writeFile(
              arg,
              arg.endsWith('.png') && emptyPng
                ? Buffer.alloc(0)
                : arg.endsWith('.jpg')
                  ? await sharp({
                      create: { width: 8, height: 8, channels: 3, background: '#336699' },
                    })
                      .jpeg()
                      .toBuffer()
                  : Buffer.from('x'),
            );
          }
        }
      }),
      probe: jest.fn((file: string) => {
        const ms = probeMs[path.basename(file)];
        return Promise.resolve({
          hasVideo: !file.endsWith('.wav'),
          hasAudio: true,
          width: 720,
          height: 960,
          durationMs: ms ?? (file.includes('chunk-full') ? 8785 : 2000),
        });
      }),
      finalizeOutput: jest.fn((part: string, final: string) => fs.rename(part, final)),
    };
    const storage = {
      readUploadsFile: jest.fn(() => Promise.resolve(Buffer.from('mp3'))),
      sceneRelDir: jest.fn(
        (_u: string, _p: string, idx: number) => `commercials/u1/p1/scenes/${idx}/g1`,
      ),
      prepareStreamTarget: jest.fn((rel: string, name: string) =>
        Promise.resolve({
          partPath: path.join(tempDir, `${name}.part`),
          finalPath: path.join(tempDir, name),
          url: `/uploads/${rel}/${name}`,
        }),
      ),
      copyFile: jest.fn((src: string, dest: string) => fs.copyFile(src, dest)),
      saveFile: jest.fn((rel: string, name: string) => Promise.resolve(`/uploads/${rel}/${name}`)),
    };
    const rows = [0, 1, 2].map((i) => ({ id: `row-${i}`, idx: i, generation: 1 }));
    const manager = {
      getRepository: jest.fn(() => ({
        save: jest.fn((asset: Record<string, unknown>) => {
          saved.push(asset);
          return Promise.resolve(asset);
        }),
      })),
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) =>
          Promise.resolve(
            entity === AnimationAsset
              ? {
                  id: where.id,
                  fileUrl: `/uploads/${where.id}.bin`,
                  durationMs: 2000,
                  metadata: {},
                }
              : null,
          ),
        ),
        find: jest.fn(() => Promise.resolve(entity === McScene ? rows : [])),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    };
    pipeline = {
      markChunkSceneReady: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
    };
    helpers = {
      checkResolution: jest.fn().mockResolvedValue({
        width: 720,
        height: 960,
        longSidePx: 960,
        requiredLongSidePx: null,
        ok: null,
      }),
      inspect: jest.fn().mockResolvedValue(null),
      billing: jest.fn().mockReturnValue({
        providerCostUsd: 0.4937,
        billedDurationMs: 8785,
        engineRecord: {
          engine: { model: KLING_AVATAR_MODEL, usdPerSecond: 0.0562 },
          billedDurationMs: 8785,
        },
      }),
    };
    ingest = new McTalkChunkIngest(
      dataSource as unknown as DataSource,
      ffmpeg as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
      pipeline as unknown as McPipelineService,
      new Logger('spec'),
    );
  });

  afterEach(() => fs.rm(tempDir, { recursive: true, force: true }));

  const run = () =>
    ingest.run(
      {
        step,
        project: { id: 'p1', userId: 'u1', title: 'T', kitId: 'k' } as McProject,
        chunk,
        tempDir,
        videoPath: path.join(tempDir, 'raw.mp4'),
        probe: { width: 720, height: 960, durationMs: 8900 },
      },
      helpers as unknown as ChunkIngestHelpers,
    );

  it('um único ffmpeg conforma e fatia em 3; o trecho inteiro é inspecionado UMA vez', async () => {
    await run();
    const conform = ffmpegRuns.filter((a) => a.join(' ').includes('split='));
    expect(conform).toHaveLength(1);
    expect(conform[0].join(' ')).toContain('split=4');
    expect(helpers.inspect).toHaveBeenCalledTimes(1);
    const clip = helpers.inspect.mock.calls[0][2] as { path: string; speechWindows: unknown[] };
    expect(path.basename(clip.path)).toBe('chunk-full.mp4');
  });

  it('publica uma fatia por cena e o trecho inteiro; só a líder leva custo, motor e a lista de fatias', async () => {
    await run();
    const slices = saved.filter((a) => a.kind === 'scene_synced');
    const full = saved.filter((a) => a.kind === 'talk_chunk_clip');
    expect(slices).toHaveLength(3);
    expect(full).toHaveLength(1);
    const meta = slices.map((a) => a.metadata as Record<string, unknown>);
    expect(meta.map((m) => m.sceneId)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(meta.map((m) => [m.speechMs, m.joinedToNext])).toEqual([
      [2168, true],
      [1907, true],
      [4310, false],
    ]);
    expect(meta[0].providerCostUsd).toBe(0.4937);
    expect(meta[0].billedDurationMs).toBe(8785);
    expect(meta[1]).not.toHaveProperty('providerCostUsd');
    expect(meta[2]).not.toHaveProperty('providerCostUsd');
    const listed = (meta[0].chunkSlices as Array<{ assetId: string }>).map((s) => s.assetId);
    expect(listed).toEqual(slices.map((a) => a.id));
    expect((full[0].metadata as { slices: unknown[] }).slices).toHaveLength(3);
    expect(meta[0].conform).toMatchObject({ audioMs: 8785, audioPolicy: 'replace_clip_audio' });
  });

  it('na MESMA transação: seguidoras ready com a fatia delas e o step concluído com o asset da líder e o custo do trecho', async () => {
    await run();
    const slices = saved.filter((a) => a.kind === 'scene_synced');
    expect(pipeline.markChunkSceneReady).toHaveBeenCalledTimes(2);
    expect(
      pipeline.markChunkSceneReady.mock.calls.map((c) => [(c[2] as McScene).id, c[3]]),
    ).toEqual([
      ['row-1', slices[1].id],
      ['row-2', slices[2].id],
    ]);
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      step,
      expect.objectContaining({
        from: McStepStatus.INGESTING,
        outputAssetId: slices[0].id,
        providerCostUsd: 0.4937,
        consumeOnSuccess: false,
      }),
    );
    const order = [
      ...pipeline.markChunkSceneReady.mock.invocationCallOrder,
      pipeline.completeStepAndAdvance.mock.invocationCallOrder[0],
    ];
    expect(order[2]).toBeGreaterThan(order[1]); // as seguidoras antes da conclusão que avança o scheduler
  });

  it('clipe curto demais (> 300 ms) reprova como clip_too_short ANTES de gastar ffmpeg de fatiamento', async () => {
    await expect(
      ingest.run(
        {
          step,
          project: { id: 'p1', userId: 'u1', title: 'T', kitId: 'k' } as McProject,
          chunk,
          tempDir,
          videoPath: path.join(tempDir, 'raw.mp4'),
          probe: { width: 720, height: 960, durationMs: 6000 },
        },
        helpers as unknown as ChunkIngestHelpers,
      ),
    ).rejects.toMatchObject({ code: 'clip_too_short' });
    expect(ffmpegRuns.filter((a) => a.join(' ').includes('split='))).toHaveLength(0);
    expect(pipeline.completeStepAndAdvance).not.toHaveBeenCalled();
  });

  describe('junção entre trechos (D7)', () => {
    const asJoined = (over: Partial<ChunkSnapshot>) => {
      chunk = { ...chunk, ...over };
    };

    it('trecho com sucessor: guarda o ÚLTIMO quadro da última fatia como asset talk_join_frame e o aponta na líder', async () => {
      asJoined({ index: 0, count: 2 });
      await run();
      const frame = saved.find((a) => a.kind === 'talk_join_frame')!;
      expect(frame).toMatchObject({ mimeType: 'image/png', userId: 'u1' });
      expect(frame.metadata).toMatchObject({ chunkIndex: 0, sourceStepId: 'st-chunk' });
      const leader = saved.find((a) => a.kind === 'scene_synced')!;
      expect((leader.metadata as { joinFrameAssetId: string }).joinFrameAssetId).toBe(frame.id);
      const lastFrameRun = ffmpegRuns.find((a) => a.includes('-sseof'))!;
      expect(lastFrameRun[lastFrameRun.indexOf('-i') + 1]).toMatch(/slice-2\.mp4$/);
      const clip = helpers.inspect.mock.calls[0][2] as { identityReference: boolean };
      expect(clip.identityReference).toBe(false); // o 1º trecho parte do tile
    });

    it('último trecho não guarda quadro; o que parte de uma junção é inspecionado contra o tile (identity_drift)', async () => {
      asJoined({
        index: 1,
        count: 2,
        join: { fromChunkIndex: 0, fromStepHash: 'h', fromSceneRowId: 'row-0' },
      });
      await run();
      expect(saved.some((a) => a.kind === 'talk_join_frame')).toBe(false);
      expect(ffmpegRuns.some((a) => a.includes('-sseof'))).toBe(false);
      const clip = helpers.inspect.mock.calls[0][2] as { identityReference: boolean };
      expect(clip.identityReference).toBe(true);
    });

    it('quadro vazio → chunk_join_frame_missing (terminal, nada publicado como pronto)', async () => {
      asJoined({ index: 0, count: 2 });
      emptyPng = true;
      await expect(run()).rejects.toMatchObject({ code: 'chunk_join_frame_missing' });
      expect(pipeline.completeStepAndAdvance).not.toHaveBeenCalled();
      expect(saved).toHaveLength(0);
    });
  });
});
