import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { KLING_AVATAR_MODEL } from '../domain/mc-pipeline.config';
import { McStepStatus } from '../domain/mc-state-machines';
import { buildChunkTalkStep } from '../domain/mc-talk-chunk-step';
import { planTalkChunks } from '../domain/mc-talk-chunks';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McTalkingProcessor } from './mc-talking.processor';

/**
 * Bancada do submit do `talk` de um TRECHO (change video-fala-continua, 1.4): provider falso (nada paga) e
 * ffmpeg fake, que grava os bytes da "emenda" e registra os argumentos.
 */
const durations = [2168, 1907, 4310];

export function chunkStep(model = KLING_AVATAR_MODEL, ms = durations) {
  const chunks = planTalkChunks({
    speeches: ms.map((durationMs, i) => ({ sceneId: `row-${i}`, durationMs })),
    engineModel: model,
    engineMaxChunkS: 15,
    chunkMaxS: 10,
  }).chunks;
  return buildChunkTalkStep({
    ctx: {
      tileAssetId: 'a-tile',
      tileWidth: 16,
      tileHeight: 16,
      backgroundColor: '#FF0000',
      cutout: null,
      tier: 'economico',
      identityMode: 'generated',
      engine: { key: 'economico', model, usdPerSecond: 0.0562, maxChunkS: 15 },
    },
    chunk: chunks[0],
    speeches: ms.map((_m, i) => ({
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
}

/** Segundo trecho (falas 2 e 3 de quatro de 4,3 s), que parte do último quadro do trecho anterior. */
export function secondChunkStep(opts: { fromStepHash: string; backgroundColor: string }) {
  const chunks = planTalkChunks({
    speeches: [4300, 4300, 4300, 4300].map((durationMs, i) => ({
      sceneId: `row-${i}`,
      durationMs,
    })),
    engineModel: KLING_AVATAR_MODEL,
    engineMaxChunkS: 15,
    chunkMaxS: 10,
  }).chunks;
  return buildChunkTalkStep({
    ctx: {
      tileAssetId: 'a-tile',
      tileWidth: 16,
      tileHeight: 16,
      backgroundColor: opts.backgroundColor,
      cutout: null,
      tier: 'economico',
      identityMode: 'generated',
      engine: { key: 'economico', model: KLING_AVATAR_MODEL, usdPerSecond: 0.0562, maxChunkS: 15 },
    },
    chunk: chunks[1],
    speeches: [2, 3].map((i) => ({
      sceneRowId: `row-${i}`,
      sceneId: `s${i}`,
      audioAssetId: `a-tts-${i}`,
    })),
    join: { fromStepHash: opts.fromStepHash, fromSceneRowId: 'row-0' },
    motion: '',
    lang: 'pt',
    sceneType: 'talk_tile',
    attempt: 1,
    count: 2,
  });
}

export interface ChunkHarness {
  tilePng: Buffer;
  step: Record<string, unknown>;
  kit: Record<string, unknown>;
  fal: { submit: jest.Mock };
  pipeline: Record<string, jest.Mock>;
  transitions: { casTransition: jest.Mock };
  ffmpegRuns: string[][];
  ffmpegInputs: Buffer[];
  storage: { readUploadsFile: jest.Mock; mockJobsAbsDir: jest.Mock; mockJobAbsPath: jest.Mock };
  /** Steps `talk` já gravados do projeto (o trecho anterior da junção). */
  previousSteps: Array<Record<string, unknown>>;
  processor: McTalkingProcessor;
}

function fakeStorage(tilePng: Buffer, joinFramePng: Buffer): ChunkHarness['storage'] {
  return {
    mockJobsAbsDir: jest.fn(() => path.join(os.tmpdir(), 'mc-chunk-mock-jobs')),
    mockJobAbsPath: jest.fn((id: string) =>
      path.join(os.tmpdir(), 'mc-chunk-mock-jobs', `${id}.mp4`),
    ),
    readUploadsFile: jest.fn((url: string) =>
      Promise.resolve(
        url.includes('a-tile')
          ? tilePng
          : url.includes('a-join')
            ? joinFramePng
            : Buffer.from(`mp3:${url}`),
      ),
    ),
  };
}

function fakeFfmpeg(h: Pick<ChunkHarness, 'ffmpegRuns' | 'ffmpegInputs'>) {
  return {
    createTempDir: jest.fn(() => fs.mkdtemp(path.join(os.tmpdir(), 'mc-chunk-spec-'))),
    removeTempDir: jest.fn((dir: string) => fs.rm(dir, { recursive: true, force: true })),
    finalizeOutput: jest.fn().mockResolvedValue(undefined),
    run: jest.fn(async (args: string[]) => {
      h.ffmpegRuns.push(args);
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '-i') {
          const bytes = await fs.readFile(args[i + 1]).catch(() => null); // lavfi não é arquivo
          if (bytes) h.ffmpegInputs.push(bytes);
        }
      }
      await fs.writeFile(args[args.length - 1], Buffer.from('mp3-emendado'));
    }),
    probe: jest.fn(() =>
      Promise.resolve({
        hasVideo: false,
        hasAudio: true,
        width: null,
        height: null,
        durationMs: null,
      }),
    ),
  };
}

function fakeDataSource(h: Pick<ChunkHarness, 'kit' | 'previousSteps'>) {
  return {
    getRepository: jest.fn((entity: unknown) => ({
      findOneBy: jest.fn((where: { id: string }) => {
        if (entity === McScene)
          return Promise.resolve({ id: 'row-0', projectId: 'p1', idx: 0, generation: 1 });
        if (entity === McProject)
          return Promise.resolve({ id: 'p1', userId: 'u1', kitId: 'kit-1', tier: 'economico' });
        if (entity === McCharacterKit) return Promise.resolve(h.kit);
        if (entity === AnimationAsset)
          return Promise.resolve({
            id: where.id,
            fileUrl: `/uploads/${where.id}.bin`,
            durationMs: 2000,
            metadata: where.id === 'a-prev-slice' ? { joinFrameAssetId: 'a-join' } : {},
          });
        return Promise.resolve(null);
      }),
      find: jest.fn(() => Promise.resolve(entity === McStep ? h.previousSteps : [])),
    })),
    transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
      cb({ findOneByOrFail: jest.fn().mockResolvedValue({ id: 'p1', userId: 'u1' }) }),
    ),
  };
}

function baseStep(): Record<string, unknown> {
  return {
    id: 'st-chunk',
    projectId: 'p1',
    sceneId: 'row-0',
    sceneGeneration: 1,
    type: McStepType.TALK,
    status: McStepStatus.RUNNING,
    phase: 'production',
    projectRevision: 1,
    costCredits: 3 * 56,
    attempts: 1,
    providerJobId: null,
    inputSnapshot: chunkStep().snapshot,
  };
}

function baseKit(): Record<string, unknown> {
  return {
    id: 'kit-1',
    tileAssetId: 'a-tile',
    tileBackgroundColor: '#00FF00',
    identityMode: 'generated',
  };
}

function fakeFal(): ChunkHarness['fal'] {
  return {
    submit: jest.fn().mockResolvedValue({
      requestId: 'req-chunk',
      statusUrl: 'https://queue.fal.run/m/requests/req-chunk/status',
      responseUrl: 'https://queue.fal.run/m/requests/req-chunk',
    }),
  };
}

/** Provider `real` com fakes; o chamador troca `MC_PIPELINE_PROVIDER` por `mock` quando precisa. */
export async function createChunkHarness(): Promise<ChunkHarness> {
  process.env.MC_PIPELINE_PROVIDER = 'real';
  delete process.env.MC_TALK_ENGINE_ECONOMICO;
  delete process.env.MC_TALK_ENGINE_LOGO;
  const joinFramePng = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#00b140' },
  })
    .png()
    .toBuffer();
  const tilePng = await sharp({
    create: { width: 16, height: 16, channels: 4, background: '#0000ffff' },
  })
    .png()
    .toBuffer();
  const h = {
    tilePng,
    step: baseStep(),
    kit: baseKit(),
    fal: fakeFal(),
    pipeline: {} as Record<string, jest.Mock>,
    transitions: { casTransition: jest.fn().mockResolvedValue(true) },
    ffmpegRuns: [] as string[][],
    ffmpegInputs: [] as Buffer[],
    storage: fakeStorage(tilePng, joinFramePng),
    previousSteps: [] as Array<Record<string, unknown>>,
    processor: undefined as unknown as McTalkingProcessor,
  };
  h.pipeline = {
    claimStep: jest.fn(() => Promise.resolve({ ...h.step })),
    failStep: jest.fn().mockResolvedValue(undefined),
    consumeStepCredits: jest.fn().mockResolvedValue(undefined),
    notifyStep: jest.fn().mockResolvedValue(undefined),
    assertSubmitAllowed: jest.fn().mockResolvedValue(true),
  };
  h.processor = new McTalkingProcessor(
    fakeDataSource(h) as unknown as DataSource,
    h.pipeline as unknown as McPipelineService,
    h.transitions as unknown as TaskTransitionService,
    { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
    { publish: jest.fn().mockResolvedValue(undefined) } as unknown as AnimationQueueService,
    h.fal as unknown as FalQueueClient,
    fakeFfmpeg(h) as unknown as FfmpegRunner,
    h.storage as unknown as McStorageService,
  );
  return h;
}

/** Restaura `MC_PIPELINE_PROVIDER` ao valor de antes da suíte. */
export function restoreProvider(original: string | undefined): void {
  if (original === undefined) delete process.env.MC_PIPELINE_PROVIDER;
  else process.env.MC_PIPELINE_PROVIDER = original;
}
