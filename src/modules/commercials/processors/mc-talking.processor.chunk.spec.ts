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
import { KLING_AVATAR_MODEL, MINIMAX_H3_LIPSYNC_MODEL } from '../domain/mc-pipeline.config';
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
 * Submit do `talk` de um TRECHO (change video-fala-continua, 1.4): uma chamada ao motor para N falas,
 * com a emenda dos TTS como áudio e só o tile + áudio + prompt como entrada. Provider falso: nada
 * paga; o ffmpeg é fake (grava os bytes da "emenda" e registra os argumentos).
 */
describe('McTalkingProcessor — submit de trecho (fala contínua)', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  let tilePng: Buffer;
  let step: Record<string, unknown>;
  let fal: { submit: jest.Mock };
  let pipeline: Record<string, jest.Mock>;
  let transitions: { casTransition: jest.Mock };
  let ffmpegRuns: string[][];
  let ffmpegInputs: Buffer[];
  let storage: { readUploadsFile: jest.Mock };
  let processor: McTalkingProcessor;
  let kit: Record<string, unknown>;

  const durations = [2168, 1907, 4310];

  function chunkStep(model = KLING_AVATAR_MODEL, ms = durations) {
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

  beforeAll(async () => {
    tilePng = await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#0000ffff' },
    })
      .png()
      .toBuffer();
  });

  beforeEach(() => {
    process.env.MC_PIPELINE_PROVIDER = 'real';
    delete process.env.MC_TALK_ENGINE_ECONOMICO;
    delete process.env.MC_TALK_ENGINE_LOGO;
    const built = chunkStep();
    step = {
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
      inputSnapshot: built.snapshot,
    };
    kit = {
      id: 'kit-1',
      tileAssetId: 'a-tile',
      tileBackgroundColor: '#00FF00',
      identityMode: 'generated',
    };
    ffmpegRuns = [];
    ffmpegInputs = [];
    pipeline = {
      claimStep: jest.fn(() => Promise.resolve({ ...step })),
      failStep: jest.fn().mockResolvedValue(undefined),
      consumeStepCredits: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
      assertSubmitAllowed: jest.fn().mockResolvedValue(true),
    };
    transitions = { casTransition: jest.fn().mockResolvedValue(true) };
    fal = {
      submit: jest.fn().mockResolvedValue({
        requestId: 'req-chunk',
        statusUrl: 'https://queue.fal.run/m/requests/req-chunk/status',
        responseUrl: 'https://queue.fal.run/m/requests/req-chunk',
      }),
    };
    storage = {
      readUploadsFile: jest.fn((url: string) =>
        Promise.resolve(url.includes('a-tile') ? tilePng : Buffer.from(`mp3:${url}`)),
      ),
    };
    const ffmpeg = {
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(os.tmpdir(), 'mc-chunk-spec-'))),
      removeTempDir: jest.fn((dir: string) => fs.rm(dir, { recursive: true, force: true })),
      run: jest.fn(async (args: string[]) => {
        ffmpegRuns.push(args);
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '-i') ffmpegInputs.push(await fs.readFile(args[i + 1]));
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
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) => {
          if (entity === McScene)
            return Promise.resolve({ id: 'row-0', projectId: 'p1', idx: 0, generation: 1 });
          if (entity === McProject)
            return Promise.resolve({ id: 'p1', userId: 'u1', kitId: 'kit-1', tier: 'economico' });
          if (entity === McCharacterKit) return Promise.resolve(kit);
          if (entity === AnimationAsset)
            return Promise.resolve({
              id: where.id,
              fileUrl: `/uploads/${where.id}.bin`,
              durationMs: 2000,
            });
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
        cb({ findOneByOrFail: jest.fn().mockResolvedValue({ id: 'p1', userId: 'u1' }) }),
      ),
    };
    processor = new McTalkingProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      transitions as unknown as TaskTransitionService,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
      { publish: jest.fn().mockResolvedValue(undefined) } as unknown as AnimationQueueService,
      fal as unknown as FalQueueClient,
      ffmpeg as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
    );
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_PIPELINE_PROVIDER;
    else process.env.MC_PIPELINE_PROVIDER = originalProvider;
  });

  it('3 falas → UMA chamada ao motor com a emenda dos 3 TTS; entrada = só imagem, áudio e prompt', async () => {
    await processor.process({ stepId: 'st-chunk' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(fal.submit).toHaveBeenCalledTimes(1);
    const [model, input] = fal.submit.mock.calls[0] as [string, Record<string, string>];
    expect(model).toBe(KLING_AVATAR_MODEL);
    expect(Object.keys(input).sort()).toEqual(['audio_url', 'image_url', 'prompt']);
    // o áudio enviado é a emenda (saída do ffmpeg), montada a partir dos 3 TTS originais
    expect(Buffer.from(input.audio_url.split(',')[1], 'base64').toString()).toBe('mp3-emendado');
    expect(ffmpegInputs.map((b) => b.toString())).toEqual([
      'mp3:/uploads/a-tts-0.bin',
      'mp3:/uploads/a-tts-1.bin',
      'mp3:/uploads/a-tts-2.bin',
    ]);
    const splice = ffmpegRuns[0].join(' ');
    expect(splice).toContain('concat=n=5'); // 3 falas + 2 silêncios de 200 ms
    expect(splice).not.toContain('atempo');
    expect(input.prompt).toContain('one continuous take');
    // só o tile (kit) e os TTS foram lidos do disco: nenhuma arte, logo, preço ou quadro da peça
    const read = storage.readUploadsFile.mock.calls.map((c) => String(c[0]));
    expect(read.every((u) => u.includes('a-tile') || u.includes('a-tts-'))).toBe(true);
    // o snapshot do step guarda o trecho e o registro do envio
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McStep,
      'st-chunk',
      McStepStatus.RUNNING,
      McStepStatus.PROVIDER_WAIT,
      expect.objectContaining({
        providerJobId: 'req-chunk',
        inputSnapshot: expect.objectContaining({
          chunk: expect.objectContaining({ sceneIds: ['s0', 's1', 's2'] }),
          audioPadding: null,
        }),
      }),
    );
    expect(pipeline.consumeStepCredits).toHaveBeenCalledTimes(1);
  });

  it('H3 (logo): o enchimento até 5,15 s é aplicado UMA vez ao trecho; custo estimado sobre os segundos enviados', async () => {
    kit.identityMode = 'logo_as_is';
    (step.inputSnapshot as Record<string, unknown>) = {
      ...chunkStep(MINIMAX_H3_LIPSYNC_MODEL, [2000, 2000]).snapshot,
      identityMode: 'logo_as_is',
      engine: { key: 'logo', model: MINIMAX_H3_LIPSYNC_MODEL, usdPerSecond: 0.08, maxChunkS: 15 },
    };
    await processor.process({ stepId: 'st-chunk' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(fal.submit).toHaveBeenCalledTimes(1);
    const splice = ffmpegRuns[0].join(' ');
    expect(splice).toContain('-t 5.150');
    expect(splice.match(/anullsrc/g)).toHaveLength(2); // 1 gap + 1 enchimento (não por fala)
    const snapshot = (
      transitions.casTransition.mock.calls[0][5] as { inputSnapshot: Record<string, unknown> }
    ).inputSnapshot;
    expect(snapshot.audioPadding).toMatchObject({ speechMs: 4200, minS: 5 });
    expect(snapshot.estimatedProviderCostUsd).toBeCloseTo(5.15 * 0.08, 3);
  });

  it('trecho de uma fala sem cauda: o TTS vai como está, sem ffmpeg (igual ao de hoje)', async () => {
    (step.inputSnapshot as Record<string, unknown>) = chunkStep(
      KLING_AVATAR_MODEL,
      [3000],
    ).snapshot;
    await processor.process({ stepId: 'st-chunk' });
    expect(ffmpegRuns).toHaveLength(0);
    const [, input] = fal.submit.mock.calls[0] as [string, Record<string, string>];
    expect(Buffer.from(input.audio_url.split(',')[1], 'base64').toString()).toBe(
      'mp3:/uploads/a-tts-0.bin',
    );
    expect(input.prompt).toContain('Start and end in a neutral');
  });

  it('TTS de uma das falas ausente do disco → validação terminal, nada enviado ao motor', async () => {
    storage.readUploadsFile.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('a-tile') ? tilePng : url.includes('a-tts-1') ? null : Buffer.from('mp3'),
      ),
    );
    await processor.process({ stepId: 'st-chunk' });
    expect(fal.submit).not.toHaveBeenCalled();
    expect(pipeline.failStep).toHaveBeenCalledTimes(1);
  });
});
