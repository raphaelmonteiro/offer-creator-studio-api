import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource, EntityManager } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McComposeFfmpegProcessor } from './mc-compose-ffmpeg.processor';

function runWith(ffmpeg: { run: jest.Mock }, needle: string): string[] | undefined {
  return (ffmpeg.run.mock.calls as Array<[string[]]>)
    .map(([args]) => args)
    .find((args) => args.join(' ').includes(needle));
}

describe('McComposeFfmpegProcessor — step de projeto compose_ffmpeg (tarefas 4.3/4.4)', () => {
  let tempRoot: string;
  let uploadsDir: string;
  const step = {
    id: 'cmp-1',
    projectId: 'p1',
    sceneId: null,
    type: McStepType.COMPOSE_FFMPEG,
    status: McStepStatus.RUNNING,
    phase: 'assembly',
    projectRevision: 1,
    attempt: 1,
    costCredits: 0,
    attempts: 1,
  } as unknown as McStep;
  let project: Record<string, unknown>;
  let scenes: Array<Record<string, unknown>>;
  let assets: Array<Record<string, unknown>>;
  let kit: Record<string, unknown>;
  let pipeline: Record<string, jest.Mock>;
  let transitions: { casTransition: jest.Mock };
  let ffmpeg: {
    run: jest.Mock;
    probe: jest.Mock;
    createTempDir: jest.Mock;
    removeTempDir: jest.Mock;
    finalizeOutput: jest.Mock;
  };
  let storage: Record<string, jest.Mock>;
  let saved: Array<Record<string, unknown>>;
  let stepUpdates: Array<Record<string, unknown>>;
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let processor: McComposeFfmpegProcessor;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-compose-spec-'));
    uploadsDir = path.join(tempRoot, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    project = {
      id: 'p1',
      userId: 'u1',
      kitId: 'k1',
      title: 'Arte que fala',
      format: 'talking_art',
      aspectRatio: '9:16',
      channel: 'instagram',
      revision: 1,
      backgroundArtAssetId: 'art-1',
      options: { musicEnabled: false, captionsEnabled: true, products: [] },
      script: fixtureTalkTileScript({ backgroundColor: '#ABCDEF' }),
      quality: null,
    };
    scenes = ['fx-talk-1', 'fx-talk-2', 'fx-talk-3'].map((sceneId, idx) => ({
      id: `row-${idx}`,
      idx,
      scriptSceneId: sceneId,
      status: McSceneStatus.READY,
      durationS: 6,
      finalAssetId: `clip-${idx}`,
      generation: 1,
    }));
    assets = [
      { id: 'clip-0', fileUrl: '/uploads/c0.mp4', durationMs: 6000 },
      { id: 'clip-1', fileUrl: '/uploads/c1.mp4', durationMs: 7000 },
      { id: 'clip-2', fileUrl: '/uploads/c2.mp4', durationMs: 5000 },
      { id: 'art-1', kind: 'video_art', fileUrl: '/uploads/art.png', width: 1080, height: 1350 },
    ];
    kit = { id: 'k1', tileBackgroundColor: '#112233' };
    saved = [];
    stepUpdates = [];
    pipeline = {
      claimStep: jest.fn().mockResolvedValue(step),
      failStep: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
    };
    transitions = { casTransition: jest.fn().mockResolvedValue(true) };
    const durations: Record<string, number> = { 'c0.mp4': 6000, 'c1.mp4': 7000, 'c2.mp4': 5000 };
    ffmpeg = {
      run: jest.fn(async (args: string[]) => {
        const out = args[args.length - 1];
        if (out.startsWith(tempRoot)) await fs.writeFile(out, Buffer.from('video'));
      }),
      probe: jest.fn(async (file: string) => {
        const base = path.basename(file);
        if (base === 'composed.mp4') {
          return { hasVideo: true, hasAudio: true, width: 1080, height: 1920, durationMs: 18_410 };
        }
        return {
          hasVideo: true,
          hasAudio: true,
          width: 720,
          height: 960,
          durationMs: durations[base] ?? 1000,
        };
      }),
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(tempRoot, 'cmp-'))),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
      finalizeOutput: jest.fn((part: string, final: string) => fs.rename(part, final)),
    };
    storage = {
      absoluteFromUrl: jest.fn((url: string) => path.join(uploadsDir, path.basename(url))),
      finalRelDir: jest.fn(
        (u: string, p: string, v: number) => `commercials/${u}/${p}/final/v${v}`,
      ),
      copyFile: jest.fn(async (src: string, dest: string) => fs.copyFile(src, dest)),
      prepareStreamTarget: jest.fn(async (relDir: string, name: string) => {
        const finalPath = path.join(uploadsDir, name);
        return { partPath: `${finalPath}.part`, finalPath, url: `/uploads/${relDir}/${name}` };
      }),
    };
    const repo = (entity: unknown) => ({
      findOneBy: jest.fn((where: { id: string }) => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === McCharacterKit) return Promise.resolve(kit);
        if (entity === AnimationAsset)
          return Promise.resolve(assets.find((a) => a.id === where.id) ?? null);
        return Promise.resolve(null);
      }),
      find: jest.fn(() =>
        Promise.resolve(entity === McScene ? scenes : entity === AnimationAsset ? assets : []),
      ),
      count: jest.fn().mockResolvedValue(0),
    });
    dataSource = {
      getRepository: jest.fn(repo),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb({
          getRepository: jest.fn(() => ({
            save: jest.fn((obj: Record<string, unknown>) => {
              const row = { id: 'composed-asset', ...obj };
              saved.push(row);
              return Promise.resolve(row);
            }),
          })),
          update: jest.fn((_e: unknown, _w: unknown, patch: Record<string, unknown>) => {
            stepUpdates.push(patch);
            return Promise.resolve({ affected: 1 });
          }),
        } as unknown as EntityManager),
      ),
    };
    processor = new McComposeFfmpegProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      transitions as unknown as TaskTransitionService,
      ffmpeg as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('compõe arte + clipes conformados na janela em ordem de cena, com silêncio entre falas, e publica o asset composto com a timeline e a janela resolvida', async () => {
    await processor.process({ stepId: 'cmp-1' });

    expect(pipeline.failStep).not.toHaveBeenCalled();
    // passe único: arte em loop + os três clipes conformados (na ordem) + silêncio
    expect(ffmpeg.run).toHaveBeenCalledTimes(1);
    const compose = runWith(ffmpeg, 'composed.mp4') as string[];
    const inputs = compose.filter((_, i) => compose[i - 1] === '-i');
    expect(inputs).toEqual([
      path.join(uploadsDir, 'art.png'),
      path.join(uploadsDir, 'c0.mp4'),
      path.join(uploadsDir, 'c1.mp4'),
      path.join(uploadsDir, 'c2.mp4'),
      'anullsrc=r=48000:cl=stereo',
    ]);
    const graph = compose[compose.indexOf('-filter_complex') + 1];
    expect(graph).toContain('scale=1080:1920:force_original_aspect_ratio=decrease');
    expect(graph).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0xABCDEF'); // cor do roteiro vence a do kit
    // janela do roteiro (frações do quadro): 432×412 em (583, 837)
    expect(graph).toContain(
      "[base][c0]overlay=x=583:y=837:eof_action=pass:enable='between(t,0,6.2)'",
    );
    expect(graph).toContain('adelay=delays=297600S:all=1'); // 2ª fala em 6,2 s
    expect(runWith(ffmpeg, '-f concat')).toBeUndefined(); // sem cartela, sem concat
    expect(runWith(ffmpeg, 'endcard.mp4')).toBeUndefined();

    // asset composto + snapshot no step + conclusão que destrava o finalize
    expect(saved[0]).toMatchObject({
      kind: 'commercial_composed',
      fileUrl: '/uploads/commercials/u1/p1/final/v1/composed.mp4',
      width: 1080,
      height: 1920,
      metadata: expect.objectContaining({
        backgroundArtAssetId: 'art-1',
        backgroundColor: '#ABCDEF',
        graphVersion: 2,
        window: project.script && (project.script as { window: unknown }).window,
        windowPx: { x: 583, y: 837, width: 432, height: 412 },
        artRect: { x: 0, y: 285, width: 1080, height: 1350 },
        timeline: {
          totalS: 18.4,
          scenes: [
            expect.objectContaining({
              sceneId: 'fx-talk-1',
              idx: 0,
              startS: 0,
              endS: 6,
              finalAssetId: 'clip-0',
            }),
            expect.objectContaining({ sceneId: 'fx-talk-2', idx: 1, startS: 6.2, endS: 13.2 }),
            expect.objectContaining({ sceneId: 'fx-talk-3', idx: 2, startS: 13.4, endS: 18.4 }),
          ],
        },
      }),
    });
    expect(stepUpdates[0]).toMatchObject({
      inputSnapshot: expect.objectContaining({
        format: 'talking_art',
        width: 1080,
        height: 1920,
        backgroundArtPath: '/uploads/art.png',
        artWidth: 1080,
        artHeight: 1350,
        logoFace: false,
        gapMs: 200,
        clips: [
          expect.objectContaining({
            sceneId: 'fx-talk-1',
            finalAssetId: 'clip-0',
            path: '/uploads/c0.mp4',
          }),
          expect.anything(),
          expect.anything(),
        ],
      }),
    });
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      step,
      expect.objectContaining({
        from: McStepStatus.RUNNING,
        outputAssetId: 'composed-asset',
        provider: 'ffmpeg',
      }),
    );
    // progresso vai pelo canal mc_events
    expect(
      ffmpeg.run.mock.calls.every(
        ([, opts]: [string[], { onProgress?: unknown }]) => !!opts.onProgress,
      ),
    ).toBe(true);
  });

  it('cartela do roteiro: compose + cartela + concat, duração esperada com os 2 s', async () => {
    (project.script as Record<string, unknown>).endcard = { storeName: 'Mercado do Zé' };
    ffmpeg.probe.mockImplementation(async (file: string) =>
      path.basename(file) === 'composed.mp4'
        ? { hasVideo: true, hasAudio: true, width: 1080, height: 1920, durationMs: 20_420 }
        : {
            hasVideo: true,
            hasAudio: true,
            width: 720,
            height: 960,
            durationMs:
              { 'c0.mp4': 6000, 'c1.mp4': 7000, 'c2.mp4': 5000 }[path.basename(file)] ?? 1000,
          },
    );
    await processor.process({ stepId: 'cmp-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(runWith(ffmpeg, 'speech.mp4')).toBeDefined();
    expect(runWith(ffmpeg, 'endcard.mp4')?.join(' ')).toContain('Mercado do Zé');
    expect(runWith(ffmpeg, '-f concat')).toBeDefined();
    expect(saved[0]).toMatchObject({ metadata: expect.objectContaining({ endcard: true }) });
  });

  it('rosto do logo: a janela vem da caixa CONFIRMADA do projeto (frações da arte → quadro pelo contain-fit), não do roteiro', async () => {
    kit.identityMode = 'logo_as_is';
    (project.script as Record<string, unknown>).logoFace = true;
    project.logoBox = {
      x: 0.1,
      y: 0.05,
      w: 0.3,
      h: 0.1,
      logoBoxSource: 'user',
      logoBoxConfidence: null,
      logoBoxConfirmed: true,
    };
    await processor.process({ stepId: 'cmp-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const compose = runWith(ffmpeg, 'composed.mp4') as string[];
    const graph = compose[compose.indexOf('-filter_complex') + 1];
    // arte 1080×1350 em 1080×1920: faixa superior de 285 px → caixa em (108, 353)
    expect(graph).toContain("overlay=x=108:y=353:eof_action=pass:enable='between(t,0,6.2)'");
    expect(graph).toContain("scale=324:-2,crop=iw:'min(ih,136)',pad=324:136");
    expect(saved[0]).toMatchObject({
      metadata: expect.objectContaining({
        logoFace: true,
        window: { x: 0.1, y: 0.1839, w: 0.3, h: 0.0708 },
        windowPx: { x: 108, y: 353, width: 324, height: 136 },
      }),
    });
  });

  it('rosto do logo: sem cor no roteiro, o excedente da janela usa a cor amostrada da arte em volta da caixa', async () => {
    kit.identityMode = 'logo_as_is';
    (project.script as Record<string, unknown>).logoFace = true;
    (project.script as Record<string, unknown>).talkBackgroundColor = null;
    project.logoBox = {
      x: 0.1,
      y: 0.05,
      w: 0.3,
      h: 0.1,
      logoBoxSource: 'layout',
      logoBoxConfidence: null,
      logoBoxConfirmed: true,
      surroundColor: '#C62828',
    };
    await processor.process({ stepId: 'cmp-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const compose = runWith(ffmpeg, 'composed.mp4') as string[];
    const graph = compose[compose.indexOf('-filter_complex') + 1];
    expect(graph).toContain(
      "scale=324:-2,crop=iw:'min(ih,136)',pad=324:136:(ow-iw)/2:(oh-ih)/2:color=0xC62828",
    );
    expect(saved[0]).toMatchObject({
      metadata: expect.objectContaining({ backgroundColor: '#C62828' }),
    });
  });

  it('rosto do logo sem caixa confirmada ⇒ falha honesta (logo_box_unconfirmed), sem ffmpeg', async () => {
    (project.script as Record<string, unknown>).logoFace = true;
    project.logoBox = {
      x: 0.1,
      y: 0.05,
      w: 0.3,
      h: 0.1,
      logoBoxSource: 'detected',
      logoBoxConfidence: 0.82,
      logoBoxConfirmed: false,
    };
    await processor.process({ stepId: 'cmp-1' });
    expect(pipeline.failStep).toHaveBeenCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'logo_box_unconfirmed' }),
      expect.objectContaining({ fallbackCode: 'compose_failed' }),
    );
    expect(ffmpeg.run).not.toHaveBeenCalled();
  });

  it('cena sem clipe final (re-roll no meio) ⇒ step cancelado por composition_changed, sem ffmpeg', async () => {
    scenes[1].status = McSceneStatus.PENDING;
    scenes[1].finalAssetId = null;
    await processor.process({ stepId: 'cmp-1' });
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McStep,
      'cmp-1',
      McStepStatus.RUNNING,
      McStepStatus.CANCELED,
      expect.objectContaining({ errorCode: 'composition_changed' }),
    );
    expect(ffmpeg.run).not.toHaveBeenCalled();
  });

  it('arte de fundo referenciada mas ausente ⇒ failStep (background_art_missing); composto inválido ⇒ failStep', async () => {
    assets.splice(3, 1);
    await processor.process({ stepId: 'cmp-1' });
    expect(pipeline.failStep).toHaveBeenCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'background_art_missing' }),
      expect.objectContaining({ fallbackCode: 'compose_failed' }),
    );
    expect(pipeline.completeStepAndAdvance).not.toHaveBeenCalled();
  });

  it('duração do composto fora da tolerância ⇒ falha honesta (composed_duration_mismatch)', async () => {
    ffmpeg.probe.mockImplementation(async (file: string) =>
      path.basename(file) === 'composed.mp4'
        ? { hasVideo: true, hasAudio: true, width: 1080, height: 1920, durationMs: 30_000 }
        : { hasVideo: true, hasAudio: true, width: 720, height: 960, durationMs: 6000 },
    );
    await processor.process({ stepId: 'cmp-1' });
    expect(pipeline.failStep).toHaveBeenCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'composed_duration_mismatch' }),
      expect.anything(),
    );
  });
});
