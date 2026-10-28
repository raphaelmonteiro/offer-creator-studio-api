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
  let storage: { readUploadsFile: jest.Mock; mockJobsAbsDir: jest.Mock; mockJobAbsPath: jest.Mock };
  let processor: McTalkingProcessor;
  let kit: Record<string, unknown>;
  /** Steps `talk` já gravados do projeto (o trecho anterior da junção). */
  let previousSteps: Array<Record<string, unknown>>;
  let joinFramePng: Buffer;

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
    joinFramePng = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#00b140' },
    })
      .png()
      .toBuffer();
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
    previousSteps = [];
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
    const ffmpeg = {
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(os.tmpdir(), 'mc-chunk-spec-'))),
      removeTempDir: jest.fn((dir: string) => fs.rm(dir, { recursive: true, force: true })),
      finalizeOutput: jest.fn().mockResolvedValue(undefined),
      run: jest.fn(async (args: string[]) => {
        ffmpegRuns.push(args);
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '-i') {
            const bytes = await fs.readFile(args[i + 1]).catch(() => null); // lavfi não é arquivo
            if (bytes) ffmpegInputs.push(bytes);
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
              metadata: where.id === 'a-prev-slice' ? { joinFrameAssetId: 'a-join' } : {},
            });
          return Promise.resolve(null);
        }),
        find: jest.fn(() => Promise.resolve(entity === McStep ? previousSteps : [])),
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

  describe('junção entre trechos (D7): o último quadro do trecho anterior é a imagem do seguinte', () => {
    const second = () => {
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
          backgroundColor: '#00B140',
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
        chunk: chunks[1],
        speeches: [2, 3].map((i) => ({
          sceneRowId: `row-${i}`,
          sceneId: `s${i}`,
          audioAssetId: `a-tts-${i}`,
        })),
        join: { fromStepHash: 'hash-do-trecho-1', fromSceneRowId: 'row-0' },
        motion: '',
        lang: 'pt',
        sceneType: 'talk_tile',
        attempt: 1,
        count: 2,
      });
    };

    beforeEach(() => {
      (step.inputSnapshot as Record<string, unknown>) = second().snapshot;
      step.sceneId = 'row-0';
      previousSteps = [
        {
          inputHash: 'hash-do-trecho-1',
          status: McStepStatus.SUCCEEDED,
          outputAssetId: 'a-prev-slice',
        },
      ];
    });

    it('envia o quadro de junção no lugar do tile (sem recolorir) e NADA além do personagem', async () => {
      await processor.process({ stepId: 'st-chunk' });
      expect(pipeline.failStep).not.toHaveBeenCalled();
      const [, input] = fal.submit.mock.calls[0] as [string, Record<string, string>];
      expect(Object.keys(input).sort()).toEqual(['audio_url', 'image_url', 'prompt']);
      const image = Buffer.from(input.image_url.split(',')[1], 'base64');
      const { data } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
      expect([data[0], data[1], data[2]]).toEqual([0x00, 0xb1, 0x40]); // o quadro, não o tile azul
      const read = storage.readUploadsFile.mock.calls.map((c) => String(c[0]));
      expect(read.some((u) => u.includes('a-tile'))).toBe(false);
      expect(read.every((u) => u.includes('a-join') || u.includes('a-tts-'))).toBe(true);
    });

    it('trecho anterior sem o último quadro (ou não concluído) → chunk_join_frame_missing, sem chamada ao motor', async () => {
      previousSteps = [];
      await processor.process({ stepId: 'st-chunk' });
      expect(fal.submit).not.toHaveBeenCalled();
      expect(pipeline.failStep).toHaveBeenCalledWith(
        expect.anything(),
        McStepStatus.RUNNING,
        expect.objectContaining({ code: 'chunk_join_frame_missing' }),
        expect.anything(),
      );
      expect(pipeline.consumeStepCredits).not.toHaveBeenCalled();
    });

    it('trecho anterior que falhou não serve de junção (só succeeded/skipped_cached)', async () => {
      previousSteps = [
        {
          inputHash: 'hash-do-trecho-1',
          status: McStepStatus.FAILED,
          outputAssetId: 'a-prev-slice',
        },
      ];
      await processor.process({ stepId: 'st-chunk' });
      expect(fal.submit).not.toHaveBeenCalled();
    });
  });

  describe('provider mock: clipe do trecho com pose que muda com o tempo (1.9)', () => {
    beforeEach(() => {
      process.env.MC_PIPELINE_PROVIDER = 'mock';
    });

    const clipRun = () => ffmpegRuns[ffmpegRuns.length - 1];

    it('uma chamada para o trecho: duração = áudio ENVIADO + margem, áudio muxado = a emenda, pose recomeçando em 0 no 1º trecho', async () => {
      await processor.process({ stepId: 'st-chunk' });
      expect(fal.submit).not.toHaveBeenCalled();
      expect(ffmpegRuns).toHaveLength(2); // emenda + clipe
      const args = clipRun();
      expect(args[args.indexOf('lavfi') + 2]).toBe('color=c=0x2E5E9E:s=720x960:r=30:d=8.885');
      const vf = args[args.indexOf('-vf') + 1];
      expect(vf).toContain('drawbox');
      expect(vf).toContain("rotate=a='0.35*sin(2*PI*(t+0)/4)'");
      expect(args).not.toContain('-shortest');
      expect(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1]).toBe('1:a');
    });

    it('trecho com junção continua a pose da fase absoluta (instante do trecho no vídeo) e exige o quadro anterior', async () => {
      const chunks = planTalkChunks({
        speeches: [4300, 4300, 4300, 4300].map((durationMs, i) => ({
          sceneId: `row-${i}`,
          durationMs,
        })),
        engineModel: KLING_AVATAR_MODEL,
        engineMaxChunkS: 15,
        chunkMaxS: 10,
      }).chunks;
      const built = buildChunkTalkStep({
        ctx: {
          tileAssetId: 'a-tile',
          tileWidth: 16,
          tileHeight: 16,
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
        chunk: chunks[1],
        speeches: [2, 3].map((i) => ({
          sceneRowId: `row-${i}`,
          sceneId: `s${i}`,
          audioAssetId: `a-tts-${i}`,
        })),
        join: { fromStepHash: 'h-1', fromSceneRowId: 'row-0' },
        motion: '',
        lang: 'pt',
        sceneType: 'talk_tile',
        attempt: 1,
        count: 2,
      });
      (step.inputSnapshot as Record<string, unknown>) = built.snapshot;
      await processor.process({ stepId: 'st-chunk' });
      expect(pipeline.failStep).toHaveBeenCalledWith(
        expect.anything(),
        McStepStatus.RUNNING,
        expect.objectContaining({ code: 'chunk_join_frame_missing' }),
        expect.anything(),
      );
      pipeline.failStep.mockClear();
      previousSteps = [
        { inputHash: 'h-1', status: McStepStatus.SUCCEEDED, outputAssetId: 'a-prev-slice' },
      ];
      ffmpegRuns.length = 0;
      await processor.process({ stepId: 'st-chunk' });
      expect(pipeline.failStep).not.toHaveBeenCalled();
      const vf = clipRun()[clipRun().indexOf('-vf') + 1];
      expect(vf).toContain('(t+9)'); // 9,0 s = onde este trecho começa no vídeo
    });
  });
});
