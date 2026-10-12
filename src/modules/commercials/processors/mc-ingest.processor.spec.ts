import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { syntheticAlignment } from '../domain/mc-captions';
import { classifyMcError } from '../domain/mc-error-classes';
import { KLING_AVATAR_PRO_MODEL } from '../domain/mc-pipeline.config';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McIngestProcessor } from './mc-ingest.processor';
import { ClipInspection, McClipInspectorService } from '../services/mc-clip-inspector.service';

/**
 * A allowlist em si (hosts válidos/inválidos/http) é testada exaustivamente em
 * domain/mc-pipeline.config.spec — aqui o contrato do PROCESSOR: URL bloqueada
 * falha ANTES de qualquer byte trafegar (fetch nunca é chamado) e a falha cai
 * na política de classes (validação terminal).
 */
describe('McIngestProcessor — anti-SSRF do download (plano §6.8)', () => {
  const step = {
    id: 'st-1',
    projectId: 'p1',
    sceneId: 'sc1',
    sceneGeneration: 1,
    type: McStepType.LIPSYNC,
    status: McStepStatus.INGESTING,
    provider: 'fal-ai/kling-video/ai-avatar/v2/standard',
    providerJobId: 'req-1',
    costCredits: 56,
  };
  const scene = { id: 'sc1', projectId: 'p1', idx: 0, generation: 1, durationS: 10 };
  const project = { id: 'p1', userId: 'u1', title: 'T' };

  let stepRow: Record<string, unknown>;
  let pipeline: { failStep: jest.Mock; completeStepAndAdvance: jest.Mock };
  let fal: { resultVideoUrl: jest.Mock };
  let ffmpeg: {
    createTempDir: jest.Mock;
    removeTempDir: jest.Mock;
    probe: jest.Mock;
    run: jest.Mock;
    finalizeOutput: jest.Mock;
  };
  let fetchSpy: jest.SpyInstance;
  let inspector: { inspect: jest.Mock };
  let processor: McIngestProcessor;

  beforeEach(() => {
    stepRow = { ...step };
    pipeline = {
      failStep: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
    };
    fal = { resultVideoUrl: jest.fn() };
    inspector = { inspect: jest.fn().mockResolvedValue(null) };
    ffmpeg = {
      createTempDir: jest.fn().mockResolvedValue('/tmp/mc-ingest-fake'),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
      probe: jest.fn(),
      run: jest.fn(),
      finalizeOutput: jest.fn(),
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McStep) return Promise.resolve(stepRow);
          if (entity === McScene) return Promise.resolve(scene);
          if (entity === McProject) return Promise.resolve(project);
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb({})),
    };
    fetchSpy = jest.spyOn(global, 'fetch' as never);
    processor = new McIngestProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      fal as unknown as FalQueueClient,
      ffmpeg as unknown as FfmpegRunner,
      {
        sceneRelDir: jest.fn().mockReturnValue('commercials/u1/p1/scenes/0/g1'),
        copyFile: jest.fn(async (src: string, dest: string) => fs.copyFile(src, dest)),
        prepareStreamTarget: jest.fn(),
        saveFile: jest.fn(),
        mockJobAbsPath: jest.fn(),
      } as unknown as McStorageService,
      inspector as unknown as McClipInspectorService,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function expectBlocked(url: string): Promise<void> {
    fal.resultVideoUrl.mockResolvedValue(url);
    await processor.process({
      stepId: 'st-1',
      responseUrl: 'https://queue.fal.run/m/requests/req-1',
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // bloqueio ANTES de qualquer tráfego
    expect(pipeline.failStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'st-1' }),
      McStepStatus.INGESTING,
      expect.any(TerminalProviderError),
      expect.anything(),
    );
    const err = pipeline.failStep.mock.calls[0][2] as TerminalProviderError;
    expect(err.code).toBe('ingest_blocked_host');
  }

  it('host fora da allowlist → validação terminal sem fetch', async () => {
    await expectBlocked('https://evil.com/video.mp4');
  });

  it('sufixo forjado (fal.media.evil.com) → bloqueado', async () => {
    await expectBlocked('https://fal.media.evil.com/video.mp4');
  });

  it('http:// (sem TLS) → bloqueado mesmo em host da fal', async () => {
    await expectBlocked('http://v3.fal.media/files/video.mp4');
  });

  it('host permitido passa da allowlist (fetch é tentado) e falha de rede vira retry transiente', async () => {
    fal.resultVideoUrl.mockResolvedValue('https://v3.fal.media/files/ok/video.mp4');
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    await processor.process({ stepId: 'st-1' });
    expect(fetchSpy).toHaveBeenCalledWith('https://v3.fal.media/files/ok/video.mp4');
    const err = pipeline.failStep.mock.calls[0][2] as Error;
    expect(err.constructor.name).toBe('TransientProviderError');
  });

  it('step fora de ingesting → no-op (nem consulta o resultado)', async () => {
    stepRow.status = McStepStatus.SUCCEEDED;
    await processor.process({ stepId: 'st-1' });
    expect(fal.resultVideoUrl).not.toHaveBeenCalled();
    expect(pipeline.failStep).not.toHaveBeenCalled();
  });

  it('tempdir é limpo mesmo na falha (finally)', async () => {
    fal.resultVideoUrl.mockResolvedValue('https://evil.com/video.mp4');
    await processor.process({ stepId: 'st-1' });
    expect(ffmpeg.removeTempDir).toHaveBeenCalledWith('/tmp/mc-ingest-fake');
  });
});

/**
 * Step `talk` (change video-formatos-personagem, D7/D11): o clipe é
 * CONFORMADO ao áudio antes de virar asset (aparado / último quadro clonado /
 * reprovado), recortado ao aspecto do tile, remuxado com o TTS original; a
 * inspeção recebe o contexto (origem, estilo, fundo liso, janelas de fala) e
 * o asset registra motor, tier, medidas e custo pela tarifa do modelo.
 */
describe('McIngestProcessor — step talk: conformação ao áudio, inspeção por contexto, telemetria (3.5/3.7)', () => {
  const AUDIO_MS = 6000;
  let dir: string;
  let step: Record<string, unknown>;
  let audioAsset: Record<string, unknown>;
  let kit: Record<string, unknown>;
  let probes: Record<string, unknown>;
  let runs: string[][];
  let savedAssets: Array<Record<string, unknown>>;
  let pipeline: { failStep: jest.Mock; completeStepAndAdvance: jest.Mock };
  let inspector: { inspect: jest.Mock };
  let ffmpeg: Record<string, jest.Mock>;
  let fetchSpy: jest.SpyInstance;
  let processor: McIngestProcessor;

  const okInspection: ClipInspection = {
    flagged: false,
    reasons: [],
    where: null,
    description: '',
    frames: 10,
    pairs: 3,
    mouthCheck: 'checked',
    model: 'm',
    available: true,
    verdict: 'ok',
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-ingest-talk-'));
    step = {
      id: 'st-talk',
      projectId: 'p1',
      sceneId: 'sc1',
      sceneGeneration: 1,
      type: McStepType.TALK,
      status: McStepStatus.INGESTING,
      phase: 'production',
      provider: KLING_AVATAR_PRO_MODEL,
      providerJobId: 'req-1',
      costCredits: 56,
      attempts: 1,
      inputSnapshot: {
        audioAssetId: 'au1',
        tileAssetId: 'tile1',
        tileWidth: 720,
        tileHeight: 960,
        tier: 'premium',
        engine: { key: 'premium', model: KLING_AVATAR_PRO_MODEL },
        effectiveEngine: { key: 'premium', model: KLING_AVATAR_PRO_MODEL },
      },
    };
    audioAsset = {
      id: 'au1',
      fileUrl: '/uploads/au1.mp3',
      durationMs: AUDIO_MS,
      metadata: { alignment: syntheticAlignment('Olá, chegaram as ofertas da semana', 6) },
    };
    kit = { id: 'k1', source: 'logo', style: '3d_render', identityMode: 'generated' };
    // vídeo cru 9:16 mais longo que o áudio; áudio de 6 s; conformado 3:4 com a duração do áudio
    probes = {
      'video.mp4': { hasVideo: true, hasAudio: true, width: 1080, height: 1920, durationMs: 7400 },
      'voice.mp3': {
        hasVideo: false,
        hasAudio: true,
        width: null,
        height: null,
        durationMs: AUDIO_MS,
      },
      'conformed.mp4': {
        hasVideo: true,
        hasAudio: true,
        width: 1080,
        height: 1440,
        durationMs: 6010,
      },
    };
    runs = [];
    savedAssets = [];
    pipeline = {
      failStep: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
    };
    inspector = { inspect: jest.fn().mockResolvedValue(okInspection) };
    ffmpeg = {
      createTempDir: jest.fn().mockResolvedValue(dir),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
      probe: jest.fn((file: string) => {
        const key = path.basename(file);
        return probes[key]
          ? Promise.resolve(probes[key])
          : Promise.reject(new Error(`probe ${key}`));
      }),
      run: jest.fn(async (args: string[]) => {
        runs.push(args);
        const output = args[args.length - 1];
        if (output.endsWith('poster.jpg')) {
          await fs.writeFile(
            output,
            await sharp({ create: { width: 32, height: 32, channels: 3, background: '#336699' } })
              .jpeg()
              .toBuffer(),
          );
        } else {
          await fs.writeFile(output, Buffer.from('conformed-video'));
        }
      }),
      finalizeOutput: jest.fn((from: string, to: string) => fs.rename(from, to)),
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) => {
          if (entity === McStep) return Promise.resolve(step);
          if (entity === McScene)
            return Promise.resolve({
              id: 'sc1',
              projectId: 'p1',
              idx: 0,
              generation: 1,
              audioAssetId: 'au1',
            });
          if (entity === McProject)
            return Promise.resolve({
              id: 'p1',
              userId: 'u1',
              kitId: 'k1',
              title: 'T',
              tier: 'premium',
            });
          if (entity === McCharacterKit) return Promise.resolve(kit);
          if (entity === AnimationAsset) {
            if (where.id === 'au1') return Promise.resolve(audioAsset);
            if (where.id === 'tile1')
              return Promise.resolve({ id: 'tile1', width: 720, height: 960 });
          }
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
        cb({
          getRepository: () => ({
            save: jest.fn((asset: Record<string, unknown>) => {
              const row = { id: 'asset-1', ...asset };
              savedAssets.push(row);
              return Promise.resolve(row);
            }),
          }),
        }),
      ),
    };
    fetchSpy = jest
      .spyOn(global, 'fetch' as never)
      .mockImplementation(
        () => Promise.resolve(new Response(Buffer.from('fake-video'), { status: 200 })) as never,
      );
    processor = new McIngestProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      {
        resultVideoUrl: jest.fn().mockResolvedValue('https://v3.fal.media/files/ok/clip.mp4'),
      } as unknown as FalQueueClient,
      ffmpeg as unknown as FfmpegRunner,
      {
        sceneRelDir: jest.fn().mockReturnValue('commercials/u1/p1/scenes/0/g1'),
        copyFile: jest.fn(async (src: string, dest: string) => fs.copyFile(src, dest)),
        prepareStreamTarget: jest.fn(async (_rel: string, name: string) => ({
          partPath: path.join(dir, `${name}.part`),
          finalPath: path.join(dir, name),
          url: `/uploads/commercials/u1/p1/scenes/0/g1/${name}`,
        })),
        saveFile: jest.fn(async (_rel: string, name: string) => `/uploads/x/${name}`),
        readUploadsFile: jest.fn().mockResolvedValue(Buffer.from('mp3-bytes')),
        mockJobAbsPath: jest.fn(),
      } as unknown as McStorageService,
      inspector as unknown as McClipInspectorService,
    );
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function conformArgs(): string[] | undefined {
    return runs.find((args) => args[args.length - 1].endsWith('conformed.mp4'));
  }

  it('clipe mais LONGO que o áudio → aparado (-t áudio), TTS original muxado, aspecto recortado ao tile, medidas e motor gravados', async () => {
    await processor.process({
      stepId: 'st-talk',
      responseUrl: 'https://queue.fal.run/m/requests/req-1',
    });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const args = conformArgs();
    expect(args).toBeDefined();
    expect(args).toEqual(expect.arrayContaining(['-t', '6.000', '-map', '0:v:0', '-map', '1:a:0']));
    expect(args!.join(' ')).not.toContain('tpad');
    expect(args!.join(' ')).not.toContain('-shortest');
    // 9:16 do motor → 3:4 do tile, centralizado (1080×1440 em y=240)
    const vf = args![args!.indexOf('-vf') + 1];
    expect(vf).toContain('crop=1080:1440:0:240');
    // poster/asset partem do arquivo CONFORMADO
    expect(
      runs.some(
        (a) =>
          a.includes(path.join(dir, 'conformed.mp4')) && a[a.length - 1].endsWith('poster.jpg'),
      ),
    ).toBe(true);
    expect(savedAssets).toHaveLength(1);
    expect(savedAssets[0]).toMatchObject({
      kind: 'scene_synced',
      width: 1080,
      height: 1440,
      durationMs: 6010,
      metadata: expect.objectContaining({
        sceneType: 'talk_tile',
        tier: 'premium',
        engine: expect.objectContaining({
          key: 'premium',
          model: KLING_AVATAR_PRO_MODEL,
          usdPerSecond: 0.115,
        }),
        conform: expect.objectContaining({
          durationAction: 'trim',
          deltaMs: -1400,
          crop: { width: 1080, height: 1440, x: 0, y: 240 },
          rawDurationMs: 7400,
          rawWidth: 1080,
          rawHeight: 1920,
          audioMs: AUDIO_MS,
          audioPolicy: 'replace_clip_audio',
        }),
        inspected: true,
      }),
    });
    // custo = segundos do clipe CRU × tarifa do motor premium
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'st-talk' }),
      expect.objectContaining({ outputAssetId: 'asset-1', providerCostUsd: 7.4 * 0.115 }),
    );
  });

  it('clipe 200 ms mais curto → último quadro clonado (tpad) até a duração do áudio', async () => {
    probes['video.mp4'] = {
      hasVideo: true,
      hasAudio: true,
      width: 720,
      height: 960,
      durationMs: 5800,
    };
    probes['conformed.mp4'] = {
      hasVideo: true,
      hasAudio: true,
      width: 720,
      height: 960,
      durationMs: 6000,
    };
    await processor.process({ stepId: 'st-talk' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const vf = conformArgs()![conformArgs()!.indexOf('-vf') + 1];
    expect(vf).toMatch(/tpad=stop_mode=clone:stop_duration=0\.233/);
    expect(vf).not.toContain('crop=');
    expect(savedAssets[0]).toMatchObject({
      durationMs: 6000,
      metadata: expect.objectContaining({
        conform: expect.objectContaining({
          durationAction: 'pad',
          executedAction: 'pad',
          deltaMs: 200,
        }),
      }),
    });
    // dentro dos 300 ms não é aceite por teto: sem marcador de revisão
    expect((savedAssets[0].metadata as { conform: object }).conform).not.toHaveProperty('accepted');
  });

  describe('clipe 1,2 s mais curto (boca parada) — classe quality até o teto, depois aceite (H1)', () => {
    beforeEach(() => {
      probes['video.mp4'] = {
        hasVideo: true,
        hasAudio: true,
        width: 720,
        height: 960,
        durationMs: 4800,
      };
      probes['conformed.mp4'] = {
        hasVideo: true,
        hasAudio: true,
        width: 720,
        height: 960,
        durationMs: 6000,
      };
    });

    it.each([1, 2])(
      'execução %i → clip_too_short (regera); nada conformado nem publicado',
      async (attempts) => {
        step.attempts = attempts;
        await processor.process({ stepId: 'st-talk' });
        expect(conformArgs()).toBeUndefined();
        expect(savedAssets).toHaveLength(0);
        expect(inspector.inspect).not.toHaveBeenCalled();
        const err = pipeline.failStep.mock.calls[0][2] as TerminalProviderError;
        expect(err).toBeInstanceOf(TerminalProviderError);
        expect(err.code).toBe('clip_too_short');
        expect(classifyMcError(err)).toBe('quality');
        expect(pipeline.completeStepAndAdvance).not.toHaveBeenCalled();
      },
    );

    it('3ª execução (teto da classe) → NÃO é terminal: último quadro clonado até o áudio, aceito e marcado para revisão humana; inspeção ainda roda', async () => {
      step.attempts = 3;
      await processor.process({ stepId: 'st-talk' });
      expect(pipeline.failStep).not.toHaveBeenCalled();
      const args = conformArgs();
      expect(args).toBeDefined();
      const vf = args![args!.indexOf('-vf') + 1];
      // clone ilimitado: 1,2 s + 1 quadro, preso ao -t do áudio
      expect(vf).toContain('tpad=stop_mode=clone:stop_duration=1.233');
      expect(args).toEqual(expect.arrayContaining(['-t', '6.000']));
      expect(args!.join(' ')).not.toContain('-shortest');
      expect(inspector.inspect).toHaveBeenCalledTimes(1);
      expect(savedAssets).toHaveLength(1);
      expect(savedAssets[0]).toMatchObject({
        kind: 'scene_synced',
        durationMs: 6000,
        metadata: expect.objectContaining({
          conform: expect.objectContaining({
            durationAction: 'too_short',
            executedAction: 'pad',
            deltaMs: 1200,
            padS: 1.233,
            rawDurationMs: 4800,
            accepted: true,
            acceptedReason: 'clip_too_short',
            executions: 3,
          }),
        }),
      });
      expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'st-talk' }),
        expect.objectContaining({ outputAssetId: 'asset-1' }),
      );
    });
  });

  it('motor devolve largura/altura ÍMPAR (721×961) sem desvio de aspecto → filtro de paridade, medidas pares gravadas (L1)', async () => {
    probes['video.mp4'] = {
      hasVideo: true,
      hasAudio: true,
      width: 721,
      height: 961,
      durationMs: 6000,
    };
    probes['conformed.mp4'] = {
      hasVideo: true,
      hasAudio: true,
      width: 720,
      height: 960,
      durationMs: 6000,
    };
    await processor.process({ stepId: 'st-talk' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const vf = conformArgs()![conformArgs()!.indexOf('-vf') + 1];
    expect(vf).toContain('crop=trunc(iw/2)*2:trunc(ih/2)*2');
    expect(vf).not.toMatch(/crop=\d/);
    expect(savedAssets[0]).toMatchObject({
      width: 720,
      height: 960,
      metadata: expect.objectContaining({
        conform: expect.objectContaining({
          durationAction: 'keep',
          crop: null,
          rawWidth: 721,
          rawHeight: 961,
        }),
      }),
    });
  });

  it('inspeção recebe origem/estilo do kit, fundo liso e as janelas de fala do alinhamento do áudio', async () => {
    await processor.process({ stepId: 'st-talk' });
    expect(inspector.inspect).toHaveBeenCalledWith(
      path.join(dir, 'conformed.mp4'),
      6010,
      dir,
      expect.objectContaining({
        source: 'logo',
        style: '3d_render',
        backgroundKind: 'plain',
        speechWindows: expect.arrayContaining([
          expect.objectContaining({ startS: expect.any(Number), endS: expect.any(Number) }),
        ]),
      }),
    );
  });

  it('áudio sem alinhamento → janelas vazias (o inspetor pula só a checagem de boca)', async () => {
    audioAsset.metadata = {};
    await processor.process({ stepId: 'st-talk' });
    expect(inspector.inspect).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.any(String),
      expect.objectContaining({ speechWindows: [] }),
    );
    expect(pipeline.failStep).not.toHaveBeenCalled();
  });

  it('boca parada na inspeção → clip_mouth_still (quality) na 1ª execução; aceito e registrado na 3ª', async () => {
    const still: ClipInspection = {
      ...okInspection,
      flagged: true,
      reasons: ['mouth_still'],
      mouthCheck: 'still',
      verdict: 'reprovado',
      description: 'mouth frozen',
    };
    inspector.inspect.mockResolvedValue(still);
    await processor.process({ stepId: 'st-talk' });
    const err = pipeline.failStep.mock.calls[0][2] as TerminalProviderError;
    expect(err.code).toBe('clip_mouth_still');
    expect(classifyMcError(err)).toBe('quality');
    expect(savedAssets).toHaveLength(0);

    pipeline.failStep.mockClear();
    step.attempts = 3;
    await processor.process({ stepId: 'st-talk' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(savedAssets[0]).toMatchObject({
      metadata: expect.objectContaining({
        inspection: expect.objectContaining({
          reasons: ['mouth_still'],
          accepted: true,
          executions: 3,
        }),
      }),
    });
  });

  it('inspeção indisponível → clipe aceito como "não inspecionado" e sinalizado no asset', async () => {
    inspector.inspect.mockResolvedValue({
      ...okInspection,
      available: false,
      verdict: 'não inspecionado',
      frames: 0,
      pairs: 0,
      mouthCheck: 'skipped',
    });
    await processor.process({ stepId: 'st-talk' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(savedAssets[0]).toMatchObject({
      metadata: expect.objectContaining({
        inspected: false,
        inspection: expect.objectContaining({ verdict: 'não inspecionado', available: false }),
      }),
    });
  });

  it('motor efetivo de fallback fica no asset (fallbackFrom) e a tarifa é a do modelo efetivo', async () => {
    step.provider = 'fal-ai/kling-video/ai-avatar/v2/standard';
    (step.inputSnapshot as Record<string, unknown>).effectiveEngine = {
      key: 'economico',
      model: step.provider,
      fallbackFrom: 'minimax/h3-max/lip-sync/image-to-video',
    };
    await processor.process({ stepId: 'st-talk' });
    expect(savedAssets[0]).toMatchObject({
      metadata: expect.objectContaining({
        engine: expect.objectContaining({
          key: 'economico',
          usdPerSecond: 0.0562,
          fallbackFrom: 'minimax/h3-max/lip-sync/image-to-video',
        }),
      }),
    });
    expect(pipeline.completeStepAndAdvance.mock.calls[0][2]).toMatchObject({
      providerCostUsd: 7.4 * 0.0562,
    });
  });
});
