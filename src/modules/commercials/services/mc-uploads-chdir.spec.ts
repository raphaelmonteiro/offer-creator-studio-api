import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { bootCwd } from '../../../common/config/uploads-dir';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { UploadsService } from '../../uploads/uploads.service';
import { CommercialsService } from '../commercials.service';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McTalkingProcessor } from '../processors/mc-talking.processor';
import { McPipelineService } from './mc-pipeline.service';
import { McStorageService } from './mc-storage.service';
import { RemotionCarouselRenderer, RemotionModules } from './mc-carousel-renderer';

/**
 * Regressão do B4: `@remotion/bundler` faz `process.chdir` durante o `bundle()`.
 * Com `UPLOAD_DEST` RELATIVO, toda leitura/gravação de upload concorrente com
 * o bundle caía na pasta do Remotion (`missing_input_asset`, ENOENT em mascots).
 */
async function fakeBundle(tmp: string, windowMs: number): Promise<void> {
  const prev = process.cwd();
  process.chdir(tmp);
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  process.chdir(prev);
}

describe('uploads imunes à troca de diretório do bundle (B4)', () => {
  const originalCwd = process.cwd();
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  const relDir = `./.jest-uploads-${process.pid}`;
  const uploadsAbs = path.join(bootCwd(), relDir);
  let chdirTmp: string;
  let storage: McStorageService;
  const config = { get: (key: string, def?: string) => (key === 'UPLOAD_DEST' ? relDir : def) };

  beforeEach(async () => {
    process.env.MC_PIPELINE_PROVIDER = 'mock';
    chdirTmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remotion-cwd-')));
    await fs.mkdir(path.join(uploadsAbs, 'audio'), { recursive: true });
    await fs.writeFile(path.join(uploadsAbs, 'audio', 'voice.mp3'), 'mp3-bytes');
    storage = new McStorageService(config as unknown as ConfigService);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalProvider === undefined) delete process.env.MC_PIPELINE_PROVIDER;
    else process.env.MC_PIPELINE_PROVIDER = originalProvider;
    await fs.rm(uploadsAbs, { recursive: true, force: true });
    await fs.rm(chdirTmp, { recursive: true, force: true });
  });

  /** Dispara o bundle (sem await) e devolve a promessa dele; o cwd já está em `chdirTmp`. */
  function startBundle(): Promise<unknown> {
    const modules = {
      bundler: { bundle: () => fakeBundle(chdirTmp, 150).then(() => 'serve-url') },
      renderer: { openBrowser: () => Promise.resolve({ close: () => Promise.resolve() }) },
      core: {},
      entryPoint: 'index.ts',
    } as unknown as RemotionModules;
    const renderer = new RemotionCarouselRenderer({ MC_RENDER_BROWSER: '/bin/chrome' }, () =>
      Promise.resolve(modules),
    );
    const running = renderer.runtime();
    return running;
  }

  async function untilCwdChanged(): Promise<void> {
    for (let i = 0; i < 50 && process.cwd() !== chdirTmp; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(process.cwd()).toBe(chdirTmp);
  }

  function fakeDataSource(scene: object, project: object, transaction: jest.Mock) {
    return {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) => {
          if (entity === McScene) return Promise.resolve(scene);
          if (entity === McProject) return Promise.resolve(project);
          if (entity === AnimationAsset)
            return Promise.resolve({ id: where.id, fileUrl: '/uploads/audio/voice.mp3' });
          return Promise.resolve(null);
        }),
      })),
      transaction,
    };
  }

  function buildTalking(failStep: jest.Mock, transaction: jest.Mock): McTalkingProcessor {
    const step = {
      id: 'st-1',
      projectId: 'p1',
      sceneId: 'sc1',
      sceneGeneration: 1,
      type: McStepType.TALK,
      status: McStepStatus.RUNNING,
      phase: 'production',
      costCredits: 56,
      attempts: 1,
      inputSnapshot: { audioAssetId: 'a-audio', tileAssetId: 'a-tile' },
    };
    const scene = { id: 'sc1', projectId: 'p1', idx: 0, generation: 1, durationS: 6 };
    const project = { id: 'p1', userId: 'u1', kitId: 'k1', title: 'T', tier: 'economico' };
    const dataSource = fakeDataSource(scene, project, transaction);
    const ffmpeg = {
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(os.tmpdir(), 'ff-chdir-'))),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
      probe: jest.fn().mockResolvedValue({ hasVideo: false, hasAudio: true, durationMs: 4000 }),
      run: jest.fn().mockResolvedValue(undefined),
      finalizeOutput: jest.fn().mockResolvedValue(undefined),
    };
    return new McTalkingProcessor(
      dataSource as unknown as DataSource,
      {
        claimStep: jest.fn().mockResolvedValue(step),
        failStep,
        consumeStepCredits: jest.fn(),
        notifyStep: jest.fn(),
        assertSubmitAllowed: jest.fn().mockResolvedValue(true),
      } as unknown as McPipelineService,
      { casTransition: jest.fn().mockResolvedValue(true) } as unknown as TaskTransitionService,
      { appendEvent: jest.fn() } as unknown as CommercialsService,
      { publish: jest.fn() } as unknown as AnimationQueueService,
      { submit: jest.fn() } as unknown as FalQueueClient,
      ffmpeg as unknown as FfmpegRunner,
      storage,
    );
  }

  it('controle: dentro da janela, um caminho relativo sem o helper cai na pasta do bundle', async () => {
    const bundling = fakeBundle(chdirTmp, 100);
    await untilCwdChanged();
    expect(path.resolve('./uploads')).toBe(path.join(chdirTmp, 'uploads'));
    await bundling;
  });

  it('leitura, gravação, talk e mascots concluem no diretório original durante o bundle', async () => {
    const bundling = startBundle();
    await untilCwdChanged();

    const failStep = jest.fn();
    const transaction = jest.fn().mockResolvedValue(undefined);
    const talking = buildTalking(failStep, transaction);
    const uploads = new UploadsService(config as unknown as ConfigService);
    const mascots = new MascotsService(
      {} as never,
      uploads,
      {} as never,
      {} as never,
      config as unknown as ConfigService,
    );

    const [audio, target, saved, mascotRead] = await Promise.all([
      storage.readUploadsFile('/uploads/audio/voice.mp3'),
      storage.prepareStreamTarget('commercials/u1/p1/final/v1', 'final.mp4'),
      uploads.uploadFile(
        { originalname: 'm.png', buffer: Buffer.from('png'), size: 3 } as Express.Multer.File,
        'mascots',
      ),
      (
        mascots as unknown as { readLocalFile: (u: string) => Promise<Buffer | null> }
      ).readLocalFile('/uploads/audio/voice.mp3'),
      talking.process({ stepId: 'st-1' }),
    ]);
    await bundling;

    expect(audio?.toString()).toBe('mp3-bytes');
    expect(mascotRead?.toString()).toBe('mp3-bytes');
    expect(target.finalPath.startsWith(uploadsAbs)).toBe(true);
    expect(await fs.readdir(path.join(uploadsAbs, 'mascots'))).toHaveLength(1);
    expect(saved.url).toContain('/mascots/');
    expect(failStep).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(chdirTmp)).toEqual([]);
  });

  it('negativo: arquivo realmente ausente continua sendo missing_input_asset', async () => {
    await fs.rm(path.join(uploadsAbs, 'audio', 'voice.mp3'));
    const failStep = jest.fn().mockResolvedValue(undefined);
    const talking = buildTalking(failStep, jest.fn());
    await talking.process({ stepId: 'st-1' });
    expect(failStep).toHaveBeenCalledTimes(1);
    const err = failStep.mock.calls[0][2] as { code: string; message: string };
    expect(err.code).toBe('missing_input_asset');
    expect(err.message).toContain('ausente no disco');
  });
});
