import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McStepStatus } from '../domain/mc-state-machines';
import { buildChunkTalkStep, readChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { planTalkChunks } from '../domain/mc-talk-chunks';
import { KLING_AVATAR_MODEL } from '../domain/mc-pipeline.config';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McProject } from '../entities/mc-project.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { ChunkIngestHelpers, McTalkChunkIngest } from './mc-talk-chunk-ingest';

const durations = [2168, 1907, 4310];

function buildChunkAndStep() {
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
      engine: { key: 'economico', model: KLING_AVATAR_MODEL, usdPerSecond: 0.0562, maxChunkS: 15 },
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
  const step = {
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
  return { chunk: readChunkSnapshot(built.snapshot)!, step };
}

async function jpegBuffer() {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer();
}

function fakeFfmpeg(state: {
  ffmpegRuns: string[][];
  probeMs: Record<string, number>;
  flags: { emptyPng: boolean };
}) {
  return {
    createTempDir: jest.fn(() => fs.mkdtemp(path.join(os.tmpdir(), 'mc-chunk-ingest-aux-'))),
    removeTempDir: jest.fn((dir: string) => fs.rm(dir, { recursive: true, force: true })),
    run: jest.fn(async (args: string[]) => {
      state.ffmpegRuns.push(args);
      // cada saída .mp4/.wav/.jpg do comando é criada (o ffmpeg real escreveria)
      for (const arg of args) {
        if (/\.(mp4|wav|mp3|jpg|png)$/.test(arg) && !arg.includes('raw')) {
          await fs.writeFile(
            arg,
            arg.endsWith('.png') && state.flags.emptyPng
              ? Buffer.alloc(0)
              : arg.endsWith('.jpg')
                ? await jpegBuffer()
                : Buffer.from('x'),
          );
        }
      }
    }),
    probe: jest.fn((file: string) => {
      const ms = state.probeMs[path.basename(file)];
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
}

function fakeStorage(tempDir: string) {
  return {
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
}

function fakeDataSource(saved: Array<Record<string, unknown>>) {
  const rows = [0, 1, 2].map((i) => ({ id: `row-${i}`, idx: i, generation: 1 }));
  const manager = {
    getRepository: jest.fn(() => ({
      save: jest.fn((asset: Record<string, unknown>) => {
        saved.push(asset);
        return Promise.resolve(asset);
      }),
    })),
  };
  return {
    getRepository: jest.fn((entity: unknown) => ({
      findOneBy: jest.fn((where: { id: string }) =>
        Promise.resolve(
          entity === AnimationAsset
            ? { id: where.id, fileUrl: `/uploads/${where.id}.bin`, durationMs: 2000, metadata: {} }
            : null,
        ),
      ),
      find: jest.fn(() => Promise.resolve(entity === McScene ? rows : [])),
    })),
    transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  };
}

function fakeHelpers(): { [K in keyof ChunkIngestHelpers]: jest.Mock } {
  return {
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
}

/** Bancada do ingest de trecho: ffmpeg, storage, banco e pipeline falsos, com o trecho de 3 falas do Kling Avatar. */
export async function createIngestHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-chunk-ingest-'));
  const { chunk, step } = buildChunkAndStep();
  const state = {
    ffmpegRuns: [] as string[][],
    probeMs: {} as Record<string, number>,
    flags: { emptyPng: false },
  };
  const saved: Array<Record<string, unknown>> = [];
  const pipeline = {
    markChunkSceneReady: jest.fn().mockResolvedValue(undefined),
    completeStepAndAdvance: jest.fn().mockResolvedValue(true),
  };
  const helpers = fakeHelpers();
  const ingest = new McTalkChunkIngest(
    fakeDataSource(saved) as unknown as DataSource,
    fakeFfmpeg(state) as unknown as FfmpegRunner,
    fakeStorage(tempDir) as unknown as McStorageService,
    pipeline as unknown as McPipelineService,
    new Logger('spec'),
  );
  const harness = {
    ...state,
    tempDir,
    saved,
    pipeline,
    helpers,
    step,
    chunk,
    run: (probeMs = 8900) =>
      ingest.run(
        {
          step,
          project: { id: 'p1', userId: 'u1', title: 'T', kitId: 'k' } as McProject,
          chunk: harness.chunk,
          tempDir,
          videoPath: path.join(tempDir, 'raw.mp4'),
          probe: { width: 720, height: 960, durationMs: probeMs },
        },
        helpers as unknown as ChunkIngestHelpers,
      ),
  };
  return harness;
}
