import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource, EntityManager } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  ElevenLabsMusicProvider,
  MUSIC_UNAVAILABLE_CODE,
} from '../../../shared/providers/elevenlabs-music.provider';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { syntheticAlignment } from '../domain/mc-captions';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McAssemblyProcessor, MC_MUSIC_PROMPT } from './mc-assembly.processor';

/** Args de uma execução do ffmpeg identificada por um trecho do comando. */
function runWith(ffmpeg: { run: jest.Mock }, needle: string): string[] | undefined {
  return (ffmpeg.run.mock.calls as Array<[string[]]>)
    .map(([args]) => args)
    .find((args) => args.join(' ').includes(needle));
}

describe('McAssemblyProcessor — montagem multi-cena (plano §5.1 etapa 6)', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  /**
   * O ffmpeg é mockado, mas o I/O é REAL num tempdir: o processor escreve a
   * lista do concat, lê o poster e mede o arquivo final — mockar `fs` inteiro
   * esconderia justamente esses passos. O `run` fake materializa o output que
   * cada passe produziria (JPEG de verdade no poster, para o sharp funcionar).
   */
  let tempRoot: string;
  let posterBytes: Buffer;
  let uploadsDir: string;
  const step = {
    id: 'asm-1',
    projectId: 'p1',
    sceneId: null,
    type: McStepType.ASSEMBLY,
    status: McStepStatus.RUNNING,
    costCredits: 0,
    attempts: 1,
  } as unknown as McStep;

  let project: Record<string, unknown>;
  let scenes: Array<Record<string, unknown>>;
  let assets: Array<Record<string, unknown>>;
  let pipeline: {
    claimStep: jest.Mock;
    failStep: jest.Mock;
    notifyStep: jest.Mock;
    completeStepAndAdvance: jest.Mock;
    succeedProject: jest.Mock;
    sendCompletionEmail: jest.Mock;
  };
  let commercials: { appendEvent: jest.Mock };
  let music: { compose: jest.Mock };
  let ffmpeg: {
    run: jest.Mock;
    probe: jest.Mock;
    createTempDir: jest.Mock;
    removeTempDir: jest.Mock;
    finalizeOutput: jest.Mock;
  };
  let storage: {
    absoluteFromUrl: jest.Mock;
    uploadsDir: jest.Mock;
    musicCacheRelDir: jest.Mock;
    finalRelDir: jest.Mock;
    prepareStreamTarget: jest.Mock;
    saveFile: jest.Mock;
  };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let processor: McAssemblyProcessor;

  beforeAll(async () => {
    posterBytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
  });

  beforeEach(async () => {
    process.env.MC_PIPELINE_PROVIDER = 'real';
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-assembly-spec-'));
    uploadsDir = path.join(tempRoot, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    project = {
      id: 'p1',
      userId: 'u1',
      title: 'Ofertas',
      aspectRatio: '9:16',
      options: { musicEnabled: true, captionsEnabled: true, products: [] },
      script: {
        version: 2,
        scenes: [],
        seal: { products: [{ name: 'Café', price: '12,90' }] },
        endcard: { storeName: 'Mercado do Zé' },
      },
    };
    scenes = [
      {
        id: 'sc1',
        idx: 0,
        status: McSceneStatus.READY,
        durationS: 6,
        finalAssetId: 'a-final-1',
        audioAssetId: 'a-audio-1',
      },
      {
        id: 'sc2',
        idx: 1,
        status: McSceneStatus.READY,
        durationS: 5,
        finalAssetId: 'a-final-2',
        audioAssetId: null,
      },
    ];
    assets = [
      { id: 'a-final-1', fileUrl: '/uploads/c1.mp4', durationMs: 6000 },
      { id: 'a-final-2', fileUrl: '/uploads/c2.mp4', durationMs: 5000 },
      {
        id: 'a-audio-1',
        fileUrl: '/uploads/v1.mp3',
        metadata: { alignment: syntheticAlignment('Bem-vindo às ofertas da semana!', 3) },
      },
    ];

    pipeline = {
      claimStep: jest.fn().mockResolvedValue(step),
      failStep: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
      succeedProject: jest.fn().mockResolvedValue(true),
      sendCompletionEmail: jest.fn().mockResolvedValue(undefined),
    };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    music = { compose: jest.fn().mockResolvedValue(Buffer.from('mp3')) };
    ffmpeg = {
      // materializa o output do passe (último arg) para o próximo passo achar
      run: jest.fn(async (args: string[]) => {
        const out = args[args.length - 1];
        if (!out.startsWith(tempRoot)) return;
        await fs.writeFile(out, out.endsWith('.jpg') ? posterBytes : Buffer.from('video'));
      }),
      probe: jest.fn().mockResolvedValue({
        hasVideo: true,
        hasAudio: true,
        width: 720,
        height: 1280,
        durationMs: 6000,
      }),
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(tempRoot, 'asm-'))),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
      finalizeOutput: jest.fn((part: string, final: string) => fs.rename(part, final)),
    };
    storage = {
      absoluteFromUrl: jest.fn((url: string) => path.join(uploadsDir, path.basename(url))),
      uploadsDir: jest.fn(() => uploadsDir),
      musicCacheRelDir: jest.fn().mockReturnValue('commercials/music-cache'),
      finalRelDir: jest.fn().mockReturnValue('commercials/u1/p1/final/v1'),
      prepareStreamTarget: jest.fn(async () => {
        const finalPath = path.join(uploadsDir, 'final.mp4');
        return { partPath: `${finalPath}.part`, finalPath, url: '/uploads/final.mp4' };
      }),
      saveFile: jest.fn().mockResolvedValue('/uploads/x.jpg'),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => Promise.resolve(entity === McProject ? project : null)),
        find: jest.fn(() =>
          Promise.resolve(entity === McScene ? scenes : entity === AnimationAsset ? assets : []),
        ),
        count: jest.fn().mockResolvedValue(0),
        save: jest.fn((obj: Record<string, unknown>) =>
          Promise.resolve({ id: 'asset-final', ...obj }),
        ),
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb({
          getRepository: jest.fn(() => ({
            save: jest.fn((obj: Record<string, unknown>) =>
              Promise.resolve({ id: 'asset-final', ...obj }),
            ),
          })),
        } as unknown as EntityManager),
      ),
    };

    processor = new McAssemblyProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      { casTransition: jest.fn() } as unknown as TaskTransitionService,
      commercials as unknown as CommercialsService,
      music as unknown as ElevenLabsMusicProvider,
      ffmpeg as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
    );
  });

  afterEach(async () => {
    if (originalProvider === undefined) delete process.env.MC_PIPELINE_PROVIDER;
    else process.env.MC_PIPELINE_PROVIDER = originalProvider;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('normaliza cada cena, gera a cartela final e concatena tudo', async () => {
    await processor.process({ stepId: 'asm-1' });

    expect(runWith(ffmpeg, 'norm-0.mp4')).toBeDefined();
    expect(runWith(ffmpeg, 'norm-1.mp4')).toBeDefined();
    const endcard = runWith(ffmpeg, 'endcard.mp4');
    expect(endcard?.join(' ')).toContain("drawtext=text='Mercado do Zé'");
    expect(runWith(ffmpeg, '-f concat')).toBeDefined();
  });

  it('passe final leva selo por cena, legendas do TTS e a trilha com ducking', async () => {
    await processor.process({ stepId: 'asm-1' });
    const final = runWith(ffmpeg, 'final.mp4')?.join(' ') ?? '';

    expect(final).toContain("text='CAFÉ — R$ 12,90'"); // selo do produto
    expect(final).toContain('Bem-vindo'); // legenda da cena falada
    expect(final).toContain('sidechaincompress'); // ducking sob a fala
    expect(final).toContain('loudnorm=I=-14');
  });

  it('gera a trilha 1× por projeto com o prompt fixo e comprimento ≥ duração', async () => {
    await processor.process({ stepId: 'asm-1' });
    expect(music.compose).toHaveBeenCalledTimes(1);
    const call = music.compose.mock.calls[0][0] as { prompt: string; lengthMs: number };
    expect(call.prompt).toBe(MC_MUSIC_PROMPT);
    // 6s + 5s de cenas + 2s de cartela = 13s → bucket de 5s com folga
    expect(call.lengthMs).toBeGreaterThanOrEqual(13_000);
  });

  it('musicEnabled=false não chama o provider de música', async () => {
    (project.options as Record<string, unknown>).musicEnabled = false;
    await processor.process({ stepId: 'asm-1' });
    expect(music.compose).not.toHaveBeenCalled();
    expect(runWith(ffmpeg, 'final.mp4')?.join(' ')).not.toContain('sidechaincompress');
  });

  it('captionsEnabled=false não queima legenda (selo continua)', async () => {
    (project.options as Record<string, unknown>).captionsEnabled = false;
    await processor.process({ stepId: 'asm-1' });
    const final = runWith(ffmpeg, 'final.mp4')?.join(' ') ?? '';
    expect(final).not.toContain('Bem-vindo');
    expect(final).toContain('CAFÉ');
  });

  it('DEGRADAÇÃO: music_unavailable NÃO derruba o projeto — evento music_skipped e segue sem trilha', async () => {
    music.compose.mockRejectedValue(
      new TerminalProviderError('conta sem Eleven Music', MUSIC_UNAVAILABLE_CODE),
    );

    await processor.process({ stepId: 'asm-1' });

    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(pipeline.succeedProject).toHaveBeenCalledTimes(1); // comercial entregue
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'music_skipped', refKind: 'project', refId: 'p1' }),
    );
    expect(runWith(ffmpeg, 'final.mp4')?.join(' ')).not.toContain('sidechaincompress');
  });

  it('erro NÃO relacionado à música continua sendo falha da montagem', async () => {
    music.compose.mockRejectedValue(new TransientProviderError('rede caiu'));
    await processor.process({ stepId: 'asm-1' });
    expect(pipeline.failStep).toHaveBeenCalledTimes(1);
    expect(pipeline.succeedProject).not.toHaveBeenCalled();
  });

  it('normaliza no formato do projeto (1:1 → 960x960)', async () => {
    project.aspectRatio = '1:1';
    await processor.process({ stepId: 'asm-1' });
    expect(runWith(ffmpeg, 'norm-0.mp4')?.join(' ')).toContain('scale=960:960');
  });

  it('entrega dispara o e-mail de conclusão (fora da transação, não bloqueante)', async () => {
    await processor.process({ stepId: 'asm-1' });
    expect(pipeline.sendCompletionEmail).toHaveBeenCalledWith('p1', McProjectStatus.SUCCEEDED);
  });

  it('projeto que não venceu o CAS da entrega não manda e-mail', async () => {
    pipeline.succeedProject.mockResolvedValue(false);
    await processor.process({ stepId: 'asm-1' });
    expect(pipeline.sendCompletionEmail).not.toHaveBeenCalled();
  });

  it('composição mudou no meio (cena não-ready) → assembly morre em silêncio', async () => {
    scenes[1].status = McSceneStatus.PENDING;
    await processor.process({ stepId: 'asm-1' });
    expect(ffmpeg.run).not.toHaveBeenCalled();
    expect(pipeline.failStep).not.toHaveBeenCalled();
  });
});
