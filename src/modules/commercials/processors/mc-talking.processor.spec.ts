import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import {
  KLING_ACTION_MODEL,
  KLING_ACTION_NEGATIVE_PROMPT,
  KLING_AVATAR_MODEL,
  KLING_AVATAR_PRO_MODEL,
  MINIMAX_H3_LIPSYNC_MODEL,
} from '../domain/mc-pipeline.config';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import {
  ensureImageUnderCap,
  MC_MOCK_TALK_MARGIN_S,
  McTalkingProcessor,
  mockTalkClipDurationS,
  normalizeHexColor,
  recolorTileBackground,
  toDataUri,
} from './mc-talking.processor';
import { TransientProviderError } from '../../../shared/providers/provider-errors';

describe('ensureImageUnderCap — teto de data URI do fal (lição do PoC, ~3,3MB)', () => {
  it('imagem abaixo do teto passa intacta (mesmo buffer)', async () => {
    const small = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#3366AA' },
    })
      .png()
      .toBuffer();
    await expect(ensureImageUnderCap(small)).resolves.toBe(small);
  });

  it('imagem grande é re-encodada até caber no teto', async () => {
    // ruído RGB 1200×1200 → PNG ~4,3MB (ruído não comprime)
    const raw = randomBytes(1200 * 1200 * 3);
    const big = await sharp(raw, { raw: { width: 1200, height: 1200, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const cap = 2_500_000;
    expect(big.length).toBeGreaterThan(cap);
    const out = await ensureImageUnderCap(big, cap);
    expect(out.length).toBeLessThanOrEqual(cap);
    expect(out).not.toBe(big);
  }, 30_000);

  it('teto impossível → TerminalProviderError image_too_large (validação, sem submit)', async () => {
    const img = await sharp({
      create: { width: 256, height: 256, channels: 3, background: '#AA3366' },
    })
      .png()
      .toBuffer();
    await expect(ensureImageUnderCap(img, 10)).rejects.toMatchObject({ code: 'image_too_large' });
  });

  it('toDataUri monta o prefixo correto', () => {
    expect(toDataUri(Buffer.from('abc'), 'image/png')).toBe(
      `data:image/png;base64,${Buffer.from('abc').toString('base64')}`,
    );
  });
});

describe('McTalkingProcessor — submit do Kling AI Avatar v2 (plano §5.3/§6.4)', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  const step = {
    id: 'st-1',
    projectId: 'p1',
    sceneId: 'sc1',
    sceneGeneration: 1,
    type: McStepType.LIPSYNC,
    status: McStepStatus.RUNNING,
    costCredits: 56,
    attempts: 1,
    providerJobId: null,
  } as unknown as McStep;
  const scene = {
    id: 'sc1',
    projectId: 'p1',
    idx: 0,
    generation: 1,
    actionPrompt: 'Mascote pega o produto na prateleira',
    dialogue: 'Olá!',
    durationS: 10,
    keyframeAssetId: 'a-kf',
    audioAssetId: 'a-audio',
  };
  const project = {
    id: 'p1',
    userId: 'u1',
    title: 'T',
    // roteiro v2: o EN da ação mora no roteiro (a cena guarda o pt que a UI edita)
    script: {
      version: 2,
      scenes: [
        {
          idx: 0,
          actionPrompt: 'Mascote pega o produto na prateleira',
          actionPromptEn: 'The mascot picks a product from the shelf',
          dialogue: null,
          durationS: 10,
        },
      ],
    },
  };

  let pipeline: {
    claimStep: jest.Mock;
    failStep: jest.Mock;
    consumeStepCredits: jest.Mock;
    notifyStep: jest.Mock;
    assertSubmitAllowed: jest.Mock;
  };
  let transitions: { casTransition: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let queue: { publish: jest.Mock };
  let fal: { submit: jest.Mock };
  let storage: { readUploadsFile: jest.Mock; mockJobsAbsDir: jest.Mock; mockJobAbsPath: jest.Mock };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let processor: McTalkingProcessor;

  beforeEach(() => {
    process.env.MC_PIPELINE_PROVIDER = 'real';
    pipeline = {
      claimStep: jest.fn().mockResolvedValue({ ...step }),
      failStep: jest.fn().mockResolvedValue(undefined),
      consumeStepCredits: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
      // gate v2: legado (projectRevision null) é sempre autorizado
      assertSubmitAllowed: jest.fn().mockResolvedValue(true),
    };
    transitions = { casTransition: jest.fn().mockResolvedValue(true) };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    queue = { publish: jest.fn().mockResolvedValue(undefined) };
    fal = {
      submit: jest.fn().mockResolvedValue({
        requestId: 'req-1',
        statusUrl: 'https://queue.fal.run/m/requests/req-1/status',
        responseUrl: 'https://queue.fal.run/m/requests/req-1',
      }),
    };
    storage = {
      readUploadsFile: jest.fn().mockResolvedValue(Buffer.from('binario-pequeno')),
      mockJobsAbsDir: jest.fn(),
      mockJobAbsPath: jest.fn(),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McScene) return Promise.resolve(scene);
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McStep) return Promise.resolve(step);
          if (entity === AnimationAsset)
            return Promise.resolve({ id: 'a', fileUrl: '/uploads/x.bin' });
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
        cb({ findOneByOrFail: jest.fn().mockResolvedValue(project) }),
      ),
    };
    processor = new McTalkingProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      transitions as unknown as TaskTransitionService,
      commercials as unknown as CommercialsService,
      queue as unknown as AnimationQueueService,
      fal as unknown as FalQueueClient,
      {} as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
    );
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_PIPELINE_PROVIDER;
    else process.env.MC_PIPELINE_PROVIDER = originalProvider;
  });

  it('submete image_url+audio_url como data URIs, grava providerJobId, CONSOME no submit e agenda o poll com attempt na singletonKey', async () => {
    await processor.process({ stepId: 'st-1' });

    expect(fal.submit).toHaveBeenCalledWith(KLING_AVATAR_MODEL, {
      image_url: expect.stringMatching(/^data:image\/(png|jpeg|webp);base64,/),
      audio_url: expect.stringMatching(/^data:audio\/mpeg;base64,/),
    });
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McStep,
      'st-1',
      McStepStatus.RUNNING,
      McStepStatus.PROVIDER_WAIT,
      { provider: KLING_AVATAR_MODEL, providerJobId: 'req-1' },
    );
    expect(pipeline.consumeStepCredits).toHaveBeenCalledTimes(1); // consumo NO SUBMIT (§6.7)
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.MC_POLL,
      expect.objectContaining({ stepId: 'st-1', attempt: 1 }),
      expect.objectContaining({ startAfterSeconds: 15, singletonKey: 'poll:st-1:1' }),
    );
    // legado (sem snapshot v2): NUNCA manda prompt — executor antigo preservado
    expect(fal.submit.mock.calls[0][1]).not.toHaveProperty('prompt');
  });

  it('v2: o MOVIMENTO do snapshot vai como prompt do Avatar (ação simples + boca sincronizada), com preservação de identidade', async () => {
    pipeline.claimStep.mockResolvedValue({
      ...step,
      phase: 'production',
      projectRevision: 1,
      inputSnapshot: {
        keyframeAssetId: 'a-kf',
        audioAssetId: 'a-audio',
        motion: 'The mascot grabs the rice bag from the shelf and shows it to the camera',
        lang: 'en',
        sceneType: 'presenter',
      },
    });
    await processor.process({ stepId: 'st-1' });
    const [model, input] = fal.submit.mock.calls[0] as [string, Record<string, unknown>];
    expect(model).toBe(KLING_AVATAR_MODEL);
    expect(input.prompt).toContain('grabs the rice bag from the shelf');
    expect(input.prompt).toContain('mouth moving in sync with the speech');
    expect(input.prompt).toContain('Keep exactly the same character design');
    expect(input.image_url).toMatch(/^data:image\//);
    expect(input.audio_url).toMatch(/^data:audio\/mpeg/);
  });

  it('áudio acima do teto de 3,3MB → validação terminal SEM chamar o provider', async () => {
    storage.readUploadsFile
      .mockResolvedValueOnce(Buffer.from('keyframe-pequeno')) // imagem
      .mockResolvedValueOnce(Buffer.alloc(3_600_000)); // áudio > 3,3MB
    await processor.process({ stepId: 'st-1' });
    expect(fal.submit).not.toHaveBeenCalled();
    expect(pipeline.failStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'st-1' }),
      McStepStatus.RUNNING,
      expect.any(TerminalProviderError),
      expect.anything(),
    );
    const err = pipeline.failStep.mock.calls[0][2] as TerminalProviderError;
    expect(err.code).toBe('audio_too_large');
  });

  describe('motor de AÇÃO — cena muda no Kling v3 std i2v (v1-B1, decisão do PoC)', () => {
    beforeEach(() => {
      pipeline.claimStep.mockResolvedValue({ ...step, type: McStepType.VIDEO, id: 'st-v' });
    });

    it('submete prompt EN + preservação, negative_prompt do PoC, keyframe e duração 5|10', async () => {
      await processor.process({ stepId: 'st-v' });

      expect(fal.submit).toHaveBeenCalledTimes(1);
      const [model, input] = fal.submit.mock.calls[0] as [string, Record<string, unknown>];
      expect(model).toBe(KLING_ACTION_MODEL);
      // prompt em INGLÊS (vem do roteiro v2) + sufixo curto de preservação
      expect(input.prompt).toContain('The mascot picks a product from the shelf');
      expect(input.prompt).toContain('Keep exactly the same character design');
      expect(input.negative_prompt).toBe(KLING_ACTION_NEGATIVE_PROMPT);
      expect(input.image_url).toMatch(/^data:image\/(png|jpeg|webp);base64,/);
      expect(input.duration).toBe('10'); // cena de 10s
      expect(input).not.toHaveProperty('audio_url'); // cena muda: nada de áudio
    });

    it('consome no submit e agenda o poll igual ao lipsync (mesmo arcabouço)', async () => {
      await processor.process({ stepId: 'st-v' });
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McStep,
        'st-v',
        McStepStatus.RUNNING,
        McStepStatus.PROVIDER_WAIT,
        { provider: KLING_ACTION_MODEL, providerJobId: 'req-1' },
      );
      expect(pipeline.consumeStepCredits).toHaveBeenCalledTimes(1);
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_POLL,
        expect.objectContaining({ stepId: 'st-v', attempt: 1 }),
        expect.objectContaining({ singletonKey: 'poll:st-v:1' }),
      );
    });

    it('cena curta usa duração 5 (a mais próxima, e mais barata)', async () => {
      (dataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McScene) return Promise.resolve({ ...scene, durationS: 6 });
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McStep) return Promise.resolve(step);
          if (entity === AnimationAsset)
            return Promise.resolve({ id: 'a', fileUrl: '/uploads/x.bin' });
          return Promise.resolve(null);
        }),
      }));
      await processor.process({ stepId: 'st-v' });
      expect((fal.submit.mock.calls[0][1] as { duration: string }).duration).toBe('5');
    });

    it('sem roteiro v2 cai no actionPrompt da cena (compat de roteiro v1)', async () => {
      (dataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McScene) return Promise.resolve(scene);
          if (entity === McProject) return Promise.resolve({ ...project, script: null });
          if (entity === McStep) return Promise.resolve(step);
          if (entity === AnimationAsset)
            return Promise.resolve({ id: 'a', fileUrl: '/uploads/x.bin' });
          return Promise.resolve(null);
        }),
      }));
      await processor.process({ stepId: 'st-v' });
      expect((fal.submit.mock.calls[0][1] as { prompt: string }).prompt).toContain(
        'Mascote pega o produto',
      );
    });

    it('cena sem keyframe → validação terminal SEM chamar o provider', async () => {
      (dataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McScene) return Promise.resolve({ ...scene, keyframeAssetId: null });
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McStep) return Promise.resolve(step);
          return Promise.resolve(null);
        }),
      }));
      await processor.process({ stepId: 'st-v' });
      expect(fal.submit).not.toHaveBeenCalled();
      const err = pipeline.failStep.mock.calls[0][2] as TerminalProviderError;
      expect(err.code).toBe('missing_input_asset');
    });
  });

  it('claim perdido com providerJobId gravado → submit vira poll (recuperação §6.4)', async () => {
    pipeline.claimStep.mockResolvedValue(null);
    (dataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) => ({
      findOneBy: jest.fn(() =>
        entity === McStep
          ? Promise.resolve({ ...step, status: McStepStatus.RUNNING, providerJobId: 'req-velho' })
          : Promise.resolve(null),
      ),
    }));
    await processor.process({ stepId: 'st-1' });
    expect(fal.submit).not.toHaveBeenCalled();
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McStep,
      'st-1',
      McStepStatus.RUNNING,
      McStepStatus.PROVIDER_WAIT,
    );
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.MC_POLL,
      expect.objectContaining({ stepId: 'st-1' }),
      expect.objectContaining({ singletonKey: expect.stringMatching(/^poll:st-1:r\d+$/) }),
    );
  });

  it('claim perdido SEM providerJobId → no-op total', async () => {
    pipeline.claimStep.mockResolvedValue(null);
    await processor.process({ stepId: 'st-1' });
    expect(fal.submit).not.toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
  });
});

describe('recolorTileBackground — tile de fala (D1: fundo liso recolorido, nunca regerado)', () => {
  async function transparentTile(): Promise<Buffer> {
    // 8×8 RGBA: centro opaco azul, borda transparente
    const raw = Buffer.alloc(8 * 8 * 4, 0);
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        const i = (y * 8 + x) * 4;
        raw[i] = 0x11;
        raw[i + 1] = 0x22;
        raw[i + 2] = 0xff;
        raw[i + 3] = 0xff;
      }
    }
    return sharp(raw, { raw: { width: 8, height: 8, channels: 4 } })
      .png()
      .toBuffer();
  }

  it('achata o alfa sobre a cor pedida (canto vira a cor; personagem intacto), PNG sem alfa', async () => {
    const out = await recolorTileBackground(await transparentTile(), '#ff8800');
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([data[0], data[1], data[2]]).toEqual([0xff, 0x88, 0x00]); // canto = fundo
    const center = (4 * 8 + 4) * 3;
    expect([data[center], data[center + 1], data[center + 2]]).toEqual([0x11, 0x22, 0xff]);
  });

  it('cor inválida cai no branco padrão; normalizeHexColor aceita #RRGGBB(AA)', async () => {
    const out = await recolorTileBackground(await transparentTile(), 'laranja');
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0xff, 0xff, 0xff]);
    expect(normalizeHexColor(' #ff8800 ')).toBe('#FF8800');
    expect(normalizeHexColor('#FF8800CC')).toBe('#FF8800CC');
    expect(normalizeHexColor('ff8800')).toBeNull();
    expect(normalizeHexColor(null)).toBeNull();
  });
});

describe('McTalkingProcessor — step talk a partir do tile (D1/D2/D7, tarefa 3.4)', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  const originalEngines = {
    eco: process.env.MC_TALK_ENGINE_ECONOMICO,
    pre: process.env.MC_TALK_ENGINE_PREMIUM,
    logo: process.env.MC_TALK_ENGINE_LOGO,
  };
  const scene = {
    id: 'sc1',
    projectId: 'p1',
    idx: 0,
    generation: 1,
    actionPrompt: '',
    dialogue: 'Olá, chegaram as ofertas!',
    durationS: 6,
    keyframeAssetId: null,
    audioAssetId: 'a-audio',
  };
  let project: Record<string, unknown>;
  let kit: Record<string, unknown>;
  let step: Record<string, unknown>;
  let tilePng: Buffer;
  let pipeline: Record<string, jest.Mock>;
  let transitions: { casTransition: jest.Mock };
  let queue: { publish: jest.Mock };
  let fal: { submit: jest.Mock };
  let storage: Record<string, jest.Mock>;
  let processor: McTalkingProcessor;

  beforeAll(async () => {
    const raw = Buffer.alloc(16 * 16 * 4, 0);
    for (let y = 4; y < 12; y += 1) {
      for (let x = 4; x < 12; x += 1) {
        const i = (y * 16 + x) * 4;
        raw[i + 2] = 0xff;
        raw[i + 3] = 0xff;
      }
    }
    tilePng = await sharp(raw, { raw: { width: 16, height: 16, channels: 4 } })
      .png()
      .toBuffer();
  });

  beforeEach(() => {
    process.env.MC_PIPELINE_PROVIDER = 'real';
    delete process.env.MC_TALK_ENGINE_ECONOMICO;
    delete process.env.MC_TALK_ENGINE_PREMIUM;
    delete process.env.MC_TALK_ENGINE_LOGO;
    project = {
      id: 'p1',
      userId: 'u1',
      kitId: 'kit-1',
      title: 'T',
      tier: 'economico',
      script: null,
    };
    kit = {
      id: 'kit-1',
      tileAssetId: 'a-tile',
      tileBackgroundColor: '#00FF00',
      identityMode: 'generated',
      source: 'mascot',
    };
    step = {
      id: 'st-talk',
      projectId: 'p1',
      sceneId: 'sc1',
      sceneGeneration: 1,
      type: McStepType.TALK,
      status: McStepStatus.RUNNING,
      phase: 'production',
      projectRevision: 1,
      costCredits: 56,
      attempts: 1,
      providerJobId: null,
      inputSnapshot: {
        tileAssetId: 'a-tile',
        audioAssetId: 'a-audio',
        backgroundColor: '#FF0000',
        motion: 'Waves at the start.',
        tier: 'economico',
        identityMode: 'generated',
      },
    };
    pipeline = {
      claimStep: jest.fn(() => Promise.resolve({ ...step })),
      failStep: jest.fn().mockResolvedValue(undefined),
      consumeStepCredits: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
      assertSubmitAllowed: jest.fn().mockResolvedValue(true),
    };
    transitions = { casTransition: jest.fn().mockResolvedValue(true) };
    queue = { publish: jest.fn().mockResolvedValue(undefined) };
    fal = {
      submit: jest.fn().mockResolvedValue({
        requestId: 'req-t',
        statusUrl: 'https://queue.fal.run/m/requests/req-t/status',
        responseUrl: 'https://queue.fal.run/m/requests/req-t',
      }),
    };
    storage = {
      readUploadsFile: jest.fn((url: string) =>
        Promise.resolve(url.includes('a-tile') ? tilePng : Buffer.from('mp3-pequeno')),
      ),
      mockJobsAbsDir: jest.fn(),
      mockJobAbsPath: jest.fn(),
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) => {
          if (entity === McScene) return Promise.resolve(scene);
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McStep) return Promise.resolve(step);
          if (entity === McCharacterKit) return Promise.resolve(kit);
          if (entity === AnimationAsset)
            return Promise.resolve({ id: where.id, fileUrl: `/uploads/${where.id}.bin` });
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
        cb({ findOneByOrFail: jest.fn().mockResolvedValue(project) }),
      ),
    };
    processor = new McTalkingProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      transitions as unknown as TaskTransitionService,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
      queue as unknown as AnimationQueueService,
      fal as unknown as FalQueueClient,
      {} as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
    );
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_PIPELINE_PROVIDER;
    else process.env.MC_PIPELINE_PROVIDER = originalProvider;
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('MC_TALK_ENGINE_ECONOMICO', originalEngines.eco);
    restore('MC_TALK_ENGINE_PREMIUM', originalEngines.pre);
    restore('MC_TALK_ENGINE_LOGO', originalEngines.logo);
  });

  function submitted(): { model: string; input: Record<string, unknown> } {
    const [model, input] = fal.submit.mock.calls[0] as [string, Record<string, unknown>];
    return { model, input };
  }

  it('envia SÓ o tile de fala (recolorido para a cor da janela) + áudio + prompt — nunca arte de fundo', async () => {
    await processor.process({ stepId: 'st-talk' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const { model, input } = submitted();
    expect(model).toBe(KLING_AVATAR_MODEL); // econômico + kit gerado
    expect(Object.keys(input).sort()).toEqual(['audio_url', 'image_url', 'prompt']);
    expect(input.audio_url).toMatch(/^data:audio\/mpeg;base64,/);
    // o tile enviado é o tile do kit achatado sobre a cor da janela (#FF0000 do snapshot)
    const image = Buffer.from((input.image_url as string).split(',')[1], 'base64');
    const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([data[0], data[1], data[2]]).toEqual([0xff, 0x00, 0x00]);
    // prompt: gesto + pose neutra no início/fim + sem câmera + sem texto
    expect(input.prompt).toMatch(/^Waves at the start\. /);
    expect(input.prompt).toContain('neutral, front-facing resting pose');
    expect(input.prompt).toContain('no camera motion');
    expect(input.prompt).toMatch(/no captions, no subtitles, no signs/);
    // provider = modelo do motor; motor efetivo registrado no snapshot do step
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McStep,
      'st-talk',
      McStepStatus.RUNNING,
      McStepStatus.PROVIDER_WAIT,
      expect.objectContaining({
        provider: KLING_AVATAR_MODEL,
        providerJobId: 'req-t',
        inputSnapshot: expect.objectContaining({
          backgroundColor: '#FF0000',
          engine: expect.objectContaining({ key: 'economico', model: KLING_AVATAR_MODEL }),
          effectiveEngine: expect.objectContaining({ key: 'economico', model: KLING_AVATAR_MODEL }),
        }),
      }),
    );
    expect(pipeline.consumeStepCredits).toHaveBeenCalledTimes(1); // consumo no submit
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.MC_POLL,
      expect.objectContaining({ stepId: 'st-talk', attempt: 1 }),
      expect.objectContaining({ singletonKey: 'poll:st-talk:1' }),
    );
  });

  it('sem cor no snapshot usa a cor padrão do tile do kit', async () => {
    delete (step.inputSnapshot as Record<string, unknown>).backgroundColor;
    await processor.process({ stepId: 'st-talk' });
    const image = Buffer.from((submitted().input.image_url as string).split(',')[1], 'base64');
    const { data } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0x00, 0xff, 0x00]);
    expect(transitions.casTransition.mock.calls[0][5]).toMatchObject({
      inputSnapshot: expect.objectContaining({ backgroundColor: '#00FF00' }),
    });
  });

  it('tier premium + kit gerado → motor premium (Kling Avatar pro)', async () => {
    project.tier = 'premium';
    (step.inputSnapshot as Record<string, unknown>).tier = 'premium';
    await processor.process({ stepId: 'st-talk' });
    expect(submitted().model).toBe(KLING_AVATAR_PRO_MODEL);
    expect(submitted().input).toEqual({
      image_url: expect.stringMatching(/^data:image\/png;base64,/),
      audio_url: expect.any(String),
      prompt: expect.any(String),
    });
  });

  it('logo_as_is em projeto PREMIUM → motor de logo (H3 Max), não o premium', async () => {
    project.tier = 'premium';
    kit.identityMode = 'logo_as_is';
    kit.source = 'logo';
    (step.inputSnapshot as Record<string, unknown>).tier = 'premium';
    (step.inputSnapshot as Record<string, unknown>).identityMode = 'logo_as_is';
    await processor.process({ stepId: 'st-talk' });
    expect(submitted().model).toBe(MINIMAX_H3_LIPSYNC_MODEL);
    expect(submitted().input).toEqual({
      image_url: expect.any(String),
      audio_url: expect.any(String),
      prompt: expect.any(String),
    });
    expect(transitions.casTransition.mock.calls[0][5]).toMatchObject({
      provider: MINIMAX_H3_LIPSYNC_MODEL,
      inputSnapshot: expect.objectContaining({
        effectiveEngine: expect.objectContaining({ key: 'logo' }),
      }),
    });
  });

  it('motor do snapshot (materializer) prevalece sobre o recomputado — o hash assinou aquele modelo', async () => {
    (step.inputSnapshot as Record<string, unknown>).engine = {
      key: 'premium',
      model: KLING_AVATAR_PRO_MODEL,
      usdPerSecond: 0.115,
      maxChunkS: 15,
    };
    await processor.process({ stepId: 'st-talk' });
    expect(submitted().model).toBe(KLING_AVATAR_PRO_MODEL);
  });

  it('motor de logo indisponível (503 após retries) → fallback para o motor do tier, efetivo gravado', async () => {
    project.tier = 'premium';
    kit.identityMode = 'logo_as_is';
    (step.inputSnapshot as Record<string, unknown>).tier = 'premium';
    (step.inputSnapshot as Record<string, unknown>).identityMode = 'logo_as_is';
    fal.submit.mockRejectedValueOnce(new TransientProviderError('HTTP 503')).mockResolvedValueOnce({
      requestId: 'req-fb',
      statusUrl: 'https://queue.fal.run/m/requests/req-fb/status',
      responseUrl: 'https://queue.fal.run/m/requests/req-fb',
    });
    await processor.process({ stepId: 'st-talk' });
    expect(fal.submit).toHaveBeenCalledTimes(2);
    expect(fal.submit.mock.calls[0][0]).toBe(MINIMAX_H3_LIPSYNC_MODEL);
    expect(fal.submit.mock.calls[1][0]).toBe(KLING_AVATAR_PRO_MODEL);
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const written = transitions.casTransition.mock.calls[0][5] as {
      provider: string;
      inputSnapshot: {
        engine: Record<string, unknown>;
        effectiveEngine: Record<string, unknown>;
      };
    };
    expect(written).toMatchObject({
      provider: KLING_AVATAR_PRO_MODEL,
      providerJobId: 'req-fb',
      inputSnapshot: expect.objectContaining({
        // planejado = motor de logo com a TARIFA de logo; efetivo = motor do
        // tier com a tarifa do tier — nunca a tarifa de um no modelo do outro
        engine: { key: 'logo', model: MINIMAX_H3_LIPSYNC_MODEL, usdPerSecond: 0.08, maxChunkS: 15 },
        effectiveEngine: {
          key: 'premium',
          model: KLING_AVATAR_PRO_MODEL,
          usdPerSecond: 0.115,
          maxChunkS: 15,
          fallbackFrom: MINIMAX_H3_LIPSYNC_MODEL,
        },
      }),
    });
    // consistência (L4): provider do step = modelo efetivo; fallbackFrom = modelo planejado
    expect(written.provider).toBe(written.inputSnapshot.effectiveEngine.model);
    expect(written.inputSnapshot.effectiveEngine.fallbackFrom).toBe(
      written.inputSnapshot.engine.model,
    );
  });

  it('retry depois de um fallback: o motor PLANEJADO é tentado de novo e, funcionando, effectiveEngine volta a ser igual a engine (sem fallbackFrom velho) (L4)', async () => {
    project.tier = 'premium';
    kit.identityMode = 'logo_as_is';
    Object.assign(step.inputSnapshot as Record<string, unknown>, {
      tier: 'premium',
      identityMode: 'logo_as_is',
      engine: { key: 'logo', model: MINIMAX_H3_LIPSYNC_MODEL, usdPerSecond: 0.08, maxChunkS: 15 },
      // registro da execução anterior, que caiu no motor do tier
      effectiveEngine: {
        key: 'premium',
        model: KLING_AVATAR_PRO_MODEL,
        usdPerSecond: 0.115,
        maxChunkS: 15,
        fallbackFrom: MINIMAX_H3_LIPSYNC_MODEL,
      },
    });
    await processor.process({ stepId: 'st-talk' });
    expect(fal.submit).toHaveBeenCalledTimes(1);
    expect(fal.submit.mock.calls[0][0]).toBe(MINIMAX_H3_LIPSYNC_MODEL);
    const written = transitions.casTransition.mock.calls[0][5] as {
      provider: string;
      inputSnapshot: { engine: Record<string, unknown>; effectiveEngine: Record<string, unknown> };
    };
    expect(written.provider).toBe(MINIMAX_H3_LIPSYNC_MODEL);
    expect(written.inputSnapshot.effectiveEngine).toEqual(written.inputSnapshot.engine);
    expect(written.inputSnapshot.effectiveEngine).not.toHaveProperty('fallbackFrom');
  });

  it('motor PARCIAL no snapshot ({key, model}) → tarifa e limite completados pela config, nunca 0 gravado (L4)', async () => {
    (step.inputSnapshot as Record<string, unknown>).engine = {
      key: 'premium',
      model: KLING_AVATAR_PRO_MODEL,
    };
    await processor.process({ stepId: 'st-talk' });
    expect(submitted().model).toBe(KLING_AVATAR_PRO_MODEL);
    expect(transitions.casTransition.mock.calls[0][5]).toMatchObject({
      provider: KLING_AVATAR_PRO_MODEL,
      inputSnapshot: expect.objectContaining({
        engine: {
          key: 'premium',
          model: KLING_AVATAR_PRO_MODEL,
          usdPerSecond: 0.115,
          maxChunkS: 15,
        },
        effectiveEngine: {
          key: 'premium',
          model: KLING_AVATAR_PRO_MODEL,
          usdPerSecond: 0.115,
          maxChunkS: 15,
        },
      }),
    });
  });

  it('erro que NÃO é de disponibilidade (400) no motor de logo → sem fallback, step falha', async () => {
    kit.identityMode = 'logo_as_is';
    (step.inputSnapshot as Record<string, unknown>).identityMode = 'logo_as_is';
    fal.submit.mockRejectedValueOnce(
      new TerminalProviderError('HTTP 400: bad image', 'provider_rejected'),
    );
    await processor.process({ stepId: 'st-talk' });
    expect(fal.submit).toHaveBeenCalledTimes(1);
    expect(pipeline.failStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'st-talk' }),
      McStepStatus.RUNNING,
      expect.any(TerminalProviderError),
      expect.anything(),
    );
  });

  it('motor do tier indisponível (não é o de logo) → sem fallback: falha de fornecedor, nada consumido', async () => {
    fal.submit.mockRejectedValueOnce(new TransientProviderError('HTTP 503'));
    await processor.process({ stepId: 'st-talk' });
    expect(fal.submit).toHaveBeenCalledTimes(1);
    expect(pipeline.consumeStepCredits).not.toHaveBeenCalled();
    expect(pipeline.failStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'st-talk' }),
      McStepStatus.RUNNING,
      expect.any(TransientProviderError),
      expect.anything(),
    );
  });

  it('kit sem tile → validação terminal sem chamar o provider', async () => {
    kit.tileAssetId = null;
    (step.inputSnapshot as Record<string, unknown>).tileAssetId = null;
    await processor.process({ stepId: 'st-talk' });
    expect(fal.submit).not.toHaveBeenCalled();
    const err = pipeline.failStep.mock.calls[0][2] as TerminalProviderError;
    expect(err.code).toBe('missing_input_asset');
  });
});

/**
 * Provider mock do step `talk` (H2, D7): o clipe sintético tem a duração do
 * ÁUDIO MEDIDO mais a margem, SEM `-shortest` — assim o ingest conforma o mock
 * exatamente como um clipe real (sempre `trim`/`pad`, nunca `clip_too_short`
 * por arredondamento). O lipsync legado mantém segundos inteiros + `-shortest`.
 */
describe('McTalkingProcessor — provider mock: clipe talk com a duração do áudio medido (H2)', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  const AUDIO_MS = 12_434;
  let dir: string;
  let step: Record<string, unknown>;
  let ffmpeg: Record<string, jest.Mock>;
  let transitions: { casTransition: jest.Mock };
  let processor: McTalkingProcessor;

  beforeEach(async () => {
    process.env.MC_PIPELINE_PROVIDER = 'mock';
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-talking-mock-spec-'));
    step = {
      id: 'st-mock',
      projectId: 'p1',
      sceneId: 'sc1',
      sceneGeneration: 1,
      type: McStepType.TALK,
      status: McStepStatus.RUNNING,
      phase: 'production',
      projectRevision: 1,
      costCredits: 56,
      attempts: 1,
      providerJobId: null,
      inputSnapshot: { audioAssetId: 'a-audio', tileAssetId: 'a-tile' },
    };
    ffmpeg = {
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(dir, 'tmp-'))),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
      probe: jest.fn().mockResolvedValue({ hasVideo: false, hasAudio: true, durationMs: AUDIO_MS }),
      run: jest.fn().mockResolvedValue(undefined),
      finalizeOutput: jest.fn().mockResolvedValue(undefined),
    };
    transitions = { casTransition: jest.fn().mockResolvedValue(true) };
    const scene = {
      id: 'sc1',
      projectId: 'p1',
      idx: 0,
      generation: 1,
      durationS: 6,
      audioAssetId: 'a-audio',
    };
    const project = { id: 'p1', userId: 'u1', kitId: 'kit-1', title: 'T', tier: 'economico' };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) => {
          if (entity === McScene) return Promise.resolve(scene);
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McStep) return Promise.resolve(step);
          if (entity === AnimationAsset)
            return Promise.resolve({ id: where.id, fileUrl: `/uploads/${where.id}.bin` });
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
        cb({ findOneByOrFail: jest.fn().mockResolvedValue(project) }),
      ),
    };
    processor = new McTalkingProcessor(
      dataSource as unknown as DataSource,
      {
        claimStep: jest.fn(() => Promise.resolve({ ...step })),
        failStep: jest.fn().mockResolvedValue(undefined),
        consumeStepCredits: jest.fn().mockResolvedValue(undefined),
        notifyStep: jest.fn().mockResolvedValue(undefined),
        assertSubmitAllowed: jest.fn().mockResolvedValue(true),
      } as unknown as McPipelineService,
      transitions as unknown as TaskTransitionService,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
      { publish: jest.fn().mockResolvedValue(undefined) } as unknown as AnimationQueueService,
      { submit: jest.fn() } as unknown as FalQueueClient,
      ffmpeg as unknown as FfmpegRunner,
      {
        readUploadsFile: jest.fn().mockResolvedValue(Buffer.from('mp3-bytes')),
        mockJobsAbsDir: jest.fn().mockReturnValue(path.join(dir, 'mock-jobs')),
        mockJobAbsPath: jest.fn((jobId: string) => path.join(dir, 'mock-jobs', `${jobId}.mp4`)),
      } as unknown as McStorageService,
    );
  });

  afterEach(async () => {
    if (originalProvider === undefined) delete process.env.MC_PIPELINE_PROVIDER;
    else process.env.MC_PIPELINE_PROVIDER = originalProvider;
    await fs.rm(dir, { recursive: true, force: true });
  });

  function lavfiInput(args: string[]): string {
    return args[args.indexOf('lavfi') + 2];
  }

  it('mockTalkClipDurationS: áudio medido + 100 ms, fracionário, com piso de 1 s', () => {
    expect(MC_MOCK_TALK_MARGIN_S).toBe(0.1);
    expect(mockTalkClipDurationS(12_434)).toBe(12.534);
    expect(mockTalkClipDurationS(6400)).toBe(6.5);
    expect(mockTalkClipDurationS(300)).toBe(1);
  });

  it('talk: d= é o áudio medido (12,434 s) + margem = 12.534, SEM -shortest; provider mock agendado', async () => {
    await processor.process({ stepId: 'st-mock' });
    expect(ffmpeg.run).toHaveBeenCalledTimes(1);
    const args = ffmpeg.run.mock.calls[0][0] as string[];
    expect(lavfiInput(args)).toBe('color=c=0x2E5E9E:s=720x960:r=30:d=12.534');
    const d = Number(/:d=([\d.]+)$/.exec(lavfiInput(args))![1]);
    expect(d).toBeGreaterThanOrEqual(AUDIO_MS / 1000);
    expect(args).not.toContain('-shortest');
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v', '-map', '1:a', '-c:a', 'aac']));
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McStep,
      'st-mock',
      McStepStatus.RUNNING,
      McStepStatus.PROVIDER_WAIT,
      expect.objectContaining({ provider: 'mock' }),
    );
  });

  it('lipsync legado mantém segundos inteiros (12) e -shortest', async () => {
    step.type = McStepType.LIPSYNC;
    await processor.process({ stepId: 'st-mock' });
    const args = ffmpeg.run.mock.calls[0][0] as string[];
    expect(lavfiInput(args)).toBe('color=c=0x2E5E9E:s=720x1280:r=30:d=12');
    expect(args).toContain('-shortest');
  });
});

/**
 * Mock `talk` com FFmpeg REAL (gate MC_TEST_FFMPEG=1, como as fixtures de
 * mídia): o clipe gravado em mock-jobs/ fica a ≤ 300 ms de um áudio de 6,4 s —
 * e nunca mais curto que ele (o ingest apara a sobra; nunca "boca parada").
 */
const describeIfFfmpeg = process.env.MC_TEST_FFMPEG === '1' ? describe : describe.skip;

describeIfFfmpeg('McTalkingProcessor — mock talk com ffmpeg real (MC_TEST_FFMPEG=1)', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  const AUDIO_S = 6.4;
  let dir: string;
  let runner: FfmpegRunner;
  let voice: Buffer;

  beforeAll(async () => {
    runner = new FfmpegRunner({
      get: (key: string, fallback?: string) => process.env[key] ?? fallback,
    } as unknown as ConfigService);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-talking-mock-real-'));
    const voicePath = path.join(dir, 'voice.mp3');
    await runner.run(
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-af',
        'volume=0.1',
        '-t',
        String(AUDIO_S),
        '-codec:a',
        'libmp3lame',
        '-q:a',
        '6',
        voicePath,
      ],
      { durationMs: AUDIO_S * 1000, timeoutMs: 60_000 },
    );
    voice = await fs.readFile(voicePath);
  }, 60_000);

  afterAll(async () => {
    if (originalProvider === undefined) delete process.env.MC_PIPELINE_PROVIDER;
    else process.env.MC_PIPELINE_PROVIDER = originalProvider;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('clipe mock do talk mede o áudio (6,4 s) + margem: ≤ 300 ms de diferença, nunca mais curto', async () => {
    process.env.MC_PIPELINE_PROVIDER = 'mock';
    const step = {
      id: 'st-real',
      projectId: 'p1',
      sceneId: 'sc1',
      sceneGeneration: 1,
      type: McStepType.TALK,
      status: McStepStatus.RUNNING,
      phase: 'production',
      projectRevision: 1,
      costCredits: 56,
      attempts: 1,
      providerJobId: null,
      inputSnapshot: { audioAssetId: 'a-audio' },
    };
    const scene = {
      id: 'sc1',
      projectId: 'p1',
      idx: 0,
      generation: 1,
      durationS: 6,
      audioAssetId: 'a-audio',
    };
    const project = { id: 'p1', userId: 'u1', kitId: 'kit-1', title: 'T', tier: 'economico' };
    const transitions = { casTransition: jest.fn().mockResolvedValue(true) };
    const jobs = path.join(dir, 'mock-jobs');
    const processor = new McTalkingProcessor(
      {
        getRepository: jest.fn((entity: unknown) => ({
          findOneBy: jest.fn((where: { id: string }) => {
            if (entity === McScene) return Promise.resolve(scene);
            if (entity === McProject) return Promise.resolve(project);
            if (entity === McStep) return Promise.resolve(step);
            if (entity === AnimationAsset)
              return Promise.resolve({ id: where.id, fileUrl: `/uploads/${where.id}.mp3` });
            return Promise.resolve(null);
          }),
        })),
        transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
          cb({ findOneByOrFail: jest.fn().mockResolvedValue(project) }),
        ),
      } as unknown as DataSource,
      {
        claimStep: jest.fn(() => Promise.resolve({ ...step })),
        failStep: jest.fn((_s: unknown, _f: unknown, err: Error) => {
          throw err;
        }),
        consumeStepCredits: jest.fn().mockResolvedValue(undefined),
        notifyStep: jest.fn().mockResolvedValue(undefined),
        assertSubmitAllowed: jest.fn().mockResolvedValue(true),
      } as unknown as McPipelineService,
      transitions as unknown as TaskTransitionService,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
      { publish: jest.fn().mockResolvedValue(undefined) } as unknown as AnimationQueueService,
      { submit: jest.fn() } as unknown as FalQueueClient,
      runner,
      {
        readUploadsFile: jest.fn().mockResolvedValue(voice),
        mockJobsAbsDir: jest.fn().mockReturnValue(jobs),
        mockJobAbsPath: jest.fn((jobId: string) => path.join(jobs, `${jobId}.mp4`)),
      } as unknown as McStorageService,
    );
    await processor.process({ stepId: 'st-real' });
    const written = transitions.casTransition.mock.calls[0][5] as { providerJobId: string };
    const clip = path.join(jobs, `${written.providerJobId}.mp4`);
    const probe = await runner.probe(clip);
    expect(probe.hasVideo && probe.hasAudio).toBe(true);
    expect([probe.width, probe.height]).toEqual([720, 960]);
    const audioMs = (await runner.probe(path.join(dir, 'voice.mp3'))).durationMs as number;
    expect(probe.durationMs as number).toBeGreaterThanOrEqual(audioMs);
    expect(Math.abs((probe.durationMs as number) - AUDIO_S * 1000)).toBeLessThanOrEqual(300);
  }, 90_000);
});
