import { randomBytes } from 'crypto';
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
} from '../domain/mc-pipeline.config';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { ensureImageUnderCap, McTalkingProcessor, toDataUri } from './mc-talking.processor';

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
