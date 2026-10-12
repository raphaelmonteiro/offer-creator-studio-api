import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource, EntityManager } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { ElevenLabsMusicProvider } from '../../../shared/providers/elevenlabs-music.provider';
import { CommercialsService } from '../commercials.service';
import { syntheticAlignment } from '../domain/mc-captions';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McFinalizeProcessor } from './mc-finalize.processor';

/** Bloco final do `ametadata` do ebur128 (o que o passe de medição grava). */
function ebur128Text(m: { I: number; TPlin: number; LRA?: number }): string {
  return [
    'frame:99   pts:475200  pts_time:9.9',
    `lavfi.r128.I=${m.I}`,
    `lavfi.r128.LRA=${m.LRA ?? 3}`,
    `lavfi.r128.true_peaks_ch0=${m.TPlin}`,
    `lavfi.r128.true_peaks_ch1=${m.TPlin}`,
  ].join('\n');
}

const metadataPathOf = (args: string[]): string | null => {
  const match = /ametadata=mode=print:file='([^']+)'/.exec(args.join(' '));
  return match ? match[1] : null;
};

describe('McFinalizeProcessor — step de projeto finalize (tarefas 4.3/4.5)', () => {
  let tempRoot: string;
  let uploadsDir: string;
  let posterBytes: Buffer;
  const step = {
    id: 'fin-1',
    projectId: 'p1',
    sceneId: null,
    type: McStepType.FINALIZE,
    status: McStepStatus.RUNNING,
    phase: 'assembly',
    projectRevision: 1,
    attempt: 1,
    costCredits: 0,
    attempts: 1,
  } as unknown as McStep;
  let project: Record<string, unknown>;
  let composeSteps: Array<Record<string, unknown>>;
  let assets: Array<Record<string, unknown>>;
  let scenes: Array<Record<string, unknown>>;
  let pipeline: Record<string, jest.Mock>;
  let ffmpeg: {
    run: jest.Mock;
    probe: jest.Mock;
    createTempDir: jest.Mock;
    removeTempDir: jest.Mock;
    finalizeOutput: jest.Mock;
  };
  let storage: Record<string, jest.Mock>;
  let music: { compose: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let saved: Array<Record<string, unknown>>;
  let stepUpdates: Array<Record<string, unknown>>;
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let processor: McFinalizeProcessor;
  /** Medições devolvidas pelos passes de loudness, por tipo de passe. */
  let loudness: Record<'pass1' | 'limited' | 'final', { I: number; TPlin: number; LRA?: number }>;
  /** Tamanho (bytes) dos arquivos renderizados, por tentativa. */
  let renderSizes: number[];

  const timeline = {
    totalS: 18.4,
    scenes: [
      { sceneId: 'fx-talk-1', idx: 0, finalAssetId: 'clip-0', startS: 0, endS: 6 },
      { sceneId: 'fx-talk-2', idx: 1, finalAssetId: 'clip-1', startS: 6.2, endS: 13.2 },
      { sceneId: 'fx-talk-3', idx: 2, finalAssetId: 'clip-2', startS: 13.4, endS: 18.4 },
    ],
  };
  const texts = [
    'Olá! Chegaram as ofertas da semana no nosso mercado.',
    'Arroz integral cinco quilos por vinte e quatro e noventa, só até domingo!',
    'Corre pra cá e aproveite!',
  ];

  const runs = (): string[][] => (ffmpeg.run.mock.calls as Array<[string[]]>).map(([a]) => a);
  const renderArgs = (): string[][] =>
    runs().filter((a) => a[a.length - 1].endsWith('final.mp4') && a.includes('-filter_complex'));
  const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

  beforeAll(async () => {
    posterBytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
  });

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-finalize-spec-'));
    uploadsDir = path.join(tempRoot, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(path.join(uploadsDir, 'composed.mp4'), Buffer.from('video'));
    project = {
      id: 'p1',
      userId: 'u1',
      title: 'Arte que fala',
      format: 'talking_art',
      aspectRatio: '9:16',
      channel: 'whatsapp',
      revision: 1,
      options: { musicEnabled: false, captionsEnabled: true, products: [] },
      quality: { budgets: [], captionsMissingAccepted: true },
    };
    composeSteps = [
      {
        id: 'cmp-old',
        type: McStepType.COMPOSE_FFMPEG,
        status: McStepStatus.SUCCEEDED,
        projectRevision: 1,
        attempt: 1,
        outputAssetId: 'composed-asset',
        finishedAt: new Date('2026-10-12T10:00:00Z'),
      },
    ];
    scenes = timeline.scenes.map((s, i) => ({
      id: `row-${i}`,
      idx: i,
      scriptSceneId: s.sceneId,
      status: McSceneStatus.READY,
      audioAssetId: `tts-${i}`,
    }));
    assets = [
      {
        id: 'composed-asset',
        kind: 'commercial_composed',
        fileUrl: '/uploads/composed.mp4',
        durationMs: 18_410,
        width: 1080,
        height: 1920,
        metadata: {
          timeline,
          endcard: false,
          windowPx: { x: 707, y: 837, width: 308, height: 411 },
        },
      },
      ...texts.map((text, i) => ({
        id: `tts-${i}`,
        kind: 'commercial_audio',
        metadata: {
          alignment: syntheticAlignment(text, timeline.scenes[i].endS - timeline.scenes[i].startS),
        },
      })),
    ];
    loudness = {
      pass1: { I: -21.4, TPlin: 0.3 }, // −10,5 dBTP: +7,4 dB cabe no teto de −2
      limited: { I: -22, TPlin: 0.2 },
      final: { I: -14.1, TPlin: 0.79 }, // −2,05 dBTP
    };
    renderSizes = [];
    saved = [];
    stepUpdates = [];
    pipeline = {
      claimStep: jest.fn().mockResolvedValue(step),
      failStep: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
      succeedProject: jest.fn().mockResolvedValue(true),
      sendCompletionEmail: jest.fn().mockResolvedValue(undefined),
    };
    ffmpeg = {
      run: jest.fn(async (args: string[]) => {
        const metaPath = metadataPathOf(args);
        if (metaPath) {
          const kind = metaPath.endsWith('loudness-final.txt')
            ? 'final'
            : metaPath.includes('-lim')
              ? 'limited'
              : 'pass1';
          await fs.writeFile(metaPath, ebur128Text(loudness[kind]));
          return;
        }
        const out = args[args.length - 1];
        if (!out.startsWith(tempRoot)) return;
        if (out.endsWith('.jpg')) await fs.writeFile(out, posterBytes);
        else await fs.writeFile(out, Buffer.from('video'));
        if (out.endsWith('final.mp4')) {
          const size = renderSizes.shift();
          if (size) await fs.truncate(out, size);
        }
      }),
      probe: jest.fn().mockResolvedValue({
        hasVideo: true,
        hasAudio: true,
        width: 1080,
        height: 1920,
        durationMs: 18_410,
      }),
      createTempDir: jest.fn(() => fs.mkdtemp(path.join(tempRoot, 'fin-'))),
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
      saveFile: jest.fn((relDir: string, name: string) =>
        Promise.resolve(`/uploads/${relDir}/${name}`),
      ),
      musicCacheRelDir: jest.fn(() => 'commercials/music-cache'),
      uploadsDir: jest.fn(() => uploadsDir),
    };
    music = { compose: jest.fn() };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) => {
          if (entity === McProject) return Promise.resolve(project);
          if (entity === AnimationAsset)
            return Promise.resolve(assets.find((a) => a.id === where.id) ?? null);
          return Promise.resolve(null);
        }),
        find: jest.fn(() =>
          Promise.resolve(
            entity === McStep
              ? composeSteps
              : entity === McScene
                ? scenes
                : entity === AnimationAsset
                  ? assets
                  : [],
          ),
        ),
        count: jest.fn().mockResolvedValue(0),
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb({
          getRepository: jest.fn(() => ({
            save: jest.fn((obj: Record<string, unknown>) => {
              const row = { id: 'final-asset', ...obj };
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
    processor = new McFinalizeProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      ffmpeg as unknown as FfmpegRunner,
      storage as unknown as McStorageService,
      music as unknown as ElevenLabsMusicProvider,
      commercials as unknown as CommercialsService,
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('mede (passe 1), renderiza com legendas dos timestamps + loudnorm linear medido + perfil do canal (passe 2), mede a entrega (passe 3) e publica com a timeline', async () => {
    await processor.process({ stepId: 'fin-1' });

    expect(pipeline.failStep).not.toHaveBeenCalled();
    const all = runs();
    const measureIdx = all.findIndex((a) => metadataPathOf(a)?.endsWith('loudness-pass1.txt'));
    const renderIdx = all.findIndex((a) => a[a.length - 1].endsWith('final.mp4'));
    const verifyIdx = all.findIndex((a) => metadataPathOf(a)?.endsWith('loudness-final.txt'));
    expect(measureIdx).toBeGreaterThanOrEqual(0);
    expect(measureIdx).toBeLessThan(renderIdx);
    expect(renderIdx).toBeLessThan(verifyIdx);
    const render = renderArgs()[0];
    expect(render[render.indexOf('-i') + 1]).toBe(path.join(uploadsDir, 'composed.mp4'));
    const joined = render.join(' ');
    expect(joined).toContain('-profile:v main'); // WhatsApp: Main sem B-frames
    expect(joined).toContain('-bf 0');
    expect(joined).toContain('-b:v 5000k');
    expect(joined).toContain('+faststart');
    const graph = graphOf(render);
    expect(graph).toContain(
      'loudnorm=I=-14:TP=-2:LRA=11:linear=true:measured_I=-21.40:measured_TP=-10.46',
    );
    // legendas por linha dos timestamps do TTS, na faixa de cima (janela na base)
    expect(graph).toContain("drawtext=text='Chegaram as ofertas da semana no nosso'");
    // linhas nunca se sobrepõem: "Olá!" sai quando a linha seguinte entra
    expect(graph).toMatch(/text='Olá!\u00a0'[^,]*between\(t,0\.00,0\.58\)/); // NBSP: contorno UTF-8
    expect(graph).toMatch(/enable='between\(t,6\.2\d,/); // 2ª fala desloca para 6,2 s
    expect(graph).not.toContain('amix'); // sem trilha

    expect(saved[0]).toMatchObject({
      kind: 'commercial_final',
      fileUrl: '/uploads/commercials/u1/p1/final/v1/final.mp4',
      posterUrl: '/uploads/commercials/u1/p1/final/v1/poster.jpg',
      thumbUrl: '/uploads/commercials/u1/p1/final/v1/thumb.jpg',
      metadata: expect.objectContaining({
        composedAssetId: 'composed-asset',
        channel: 'whatsapp',
        graphVersion: 2,
        profile: expect.objectContaining({ profile: 'main', bframes: 0, videoBitrateKbps: 5000 }),
        loudness: expect.objectContaining({
          mode: 'linear',
          gainDb: 7.4,
          pass1: expect.objectContaining({ I: -21.4, TP: -10.46 }),
          output: expect.objectContaining({ I: -14.1, TP: -2.05 }),
          withinTarget: true,
        }),
        music: false,
        captions: expect.any(Number),
        captionBand: expect.objectContaining({ top: 269 }),
        captionsMissingSceneIds: [],
      }),
    });
    expect((saved[0].metadata as { captions: number }).captions).toBeGreaterThanOrEqual(3);
    expect(stepUpdates[0]).toMatchObject({
      inputSnapshot: expect.objectContaining({ graphVersion: 2, width: 1080, height: 1920 }),
    });
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      step,
      expect.objectContaining({
        from: McStepStatus.RUNNING,
        outputAssetId: 'final-asset',
        provider: 'ffmpeg',
      }),
    );
    // finalAssetId + quality.timeline entregues (instantes medidos pela composição)
    expect(pipeline.succeedProject).toHaveBeenCalledWith(expect.anything(), 'p1', 'final-asset', {
      quality: expect.objectContaining({
        captionsMissingAccepted: true,
        timeline: expect.objectContaining({
          revision: 1,
          version: 1,
          totalS: 18.4,
          endcard: null,
          captionsRequested: true,
          captionsMissingSceneIds: [],
          seals: [],
          scenes: [
            expect.objectContaining({
              sceneId: 'fx-talk-1',
              idx: 0,
              startS: 0,
              endS: 6,
              finalAssetId: 'clip-0',
              captionsMissing: false,
            }),
            expect.objectContaining({ sceneId: 'fx-talk-2', startS: 6.2, endS: 13.2 }),
            expect.objectContaining({ sceneId: 'fx-talk-3', startS: 13.4, endS: 18.4 }),
          ],
        }),
      }),
    });
    expect(pipeline.sendCompletionEmail).toHaveBeenCalledWith('p1', McProjectStatus.SUCCEEDED);
  });

  it('trilha ligada (mock): música com envelope de ducking nas janelas de fala dos timestamps e amix normalize=0; Instagram High', async () => {
    project.channel = 'instagram';
    project.options = { musicEnabled: true, captionsEnabled: false, products: [] };
    await processor.process({ stepId: 'fin-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const render = renderArgs()[0];
    expect(render.filter((a) => a.endsWith('.mp3'))).toHaveLength(1); // trilha do cache
    const graph = graphOf(render);
    expect(graph).toContain('volume=0.35,volume=');
    expect(graph).toContain(":eval=frame:enable='between(t,");
    expect(graph).toContain('amix=inputs=2:duration=first:dropout_transition=0:normalize=0');
    expect(graph).not.toContain('drawtext');
    expect(render.join(' ')).toContain('-profile:v high -level:v 4.1');
    const meta = saved[0].metadata as Record<string, unknown>;
    expect(meta.music).toBe(true);
    // as três falas (pausas de 0,2 s) fundem numa janela só de ducking
    expect(meta.ducking).toEqual([{ startS: expect.any(Number), endS: expect.any(Number) }]);
  });

  it('pico previsto acima do teto: re-mede a mistura com limitador e renderiza com alimiter + loudnorm linear', async () => {
    loudness.pass1 = { I: -24.5, TPlin: 0.67 }; // −3,5 dBTP + 10,5 dB → +7 dBTP
    loudness.limited = { I: -25.2, TPlin: 0.21 }; // −13,6 dBTP + 11,2 dB → −2,4 dBTP
    await processor.process({ stepId: 'fin-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const limitedPass = runs().find((a) => metadataPathOf(a)?.includes('-lim'));
    expect(graphOf(limitedPass as string[])).toContain('alimiter=limit=');
    expect(graphOf(renderArgs()[0])).toMatch(
      /alimiter=limit=[\d.]+:attack=5:release=50:level=0,loudnorm=/,
    );
    expect(saved[0]).toMatchObject({
      metadata: expect.objectContaining({
        loudness: expect.objectContaining({ mode: 'linear_limited', limiterDb: -13 }),
      }),
    });
  });

  it('cena sem timestamps: legendas pedidas ⇒ cena marcada em captionsMissing (visível) e a fala inteira vira janela de ducking', async () => {
    (assets[2].metadata as Record<string, unknown>).alignment = undefined;
    await processor.process({ stepId: 'fin-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(pipeline.succeedProject).toHaveBeenCalledWith(expect.anything(), 'p1', 'final-asset', {
      quality: expect.objectContaining({
        timeline: expect.objectContaining({
          captionsMissingSceneIds: ['fx-talk-2'],
          scenes: [
            expect.objectContaining({ captionsMissing: false }),
            expect.objectContaining({ sceneId: 'fx-talk-2', captionsMissing: true }),
            expect.objectContaining({ captionsMissing: false }),
          ],
        }),
      }),
    });
    const snapshot = stepUpdates[0].inputSnapshot as { speechWindows: Array<{ sceneId: string }> };
    expect(snapshot.speechWindows).toContainEqual({
      sceneId: 'fx-talk-2',
      startS: 6.2,
      endS: 13.2,
    });
  });

  it('WhatsApp acima de 16 MB: refaz com bitrate menor; persistindo, falha honesta (channel_size_exceeded)', async () => {
    renderSizes = [17_000_000, 9_000_000];
    await processor.process({ stepId: 'fin-1' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const renders = renderArgs();
    expect(renders).toHaveLength(2);
    expect(renders[0].join(' ')).toContain('-b:v 5000k');
    expect(renders[1].join(' ')).toContain('-b:v 4000k');
    expect(saved[0]).toMatchObject({
      fileSize: '9000000',
      metadata: expect.objectContaining({
        profile: expect.objectContaining({ videoBitrateKbps: 4000 }),
      }),
    });

    saved.length = 0;
    ffmpeg.run.mockClear();
    renderSizes = [17_000_000, 16_500_000, 16_100_000];
    await processor.process({ stepId: 'fin-1' });
    expect(pipeline.failStep).toHaveBeenCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'channel_size_exceeded' }),
      expect.objectContaining({ fallbackCode: 'finalize_failed' }),
    );
    expect(saved).toHaveLength(0);
  });

  it('cartela presente no composto entra na timeline (2 s após a última fala)', async () => {
    (assets[0].metadata as Record<string, unknown>).endcard = true;
    await processor.process({ stepId: 'fin-1' });
    expect(pipeline.succeedProject).toHaveBeenCalledWith(expect.anything(), 'p1', 'final-asset', {
      quality: expect.objectContaining({
        timeline: expect.objectContaining({ totalS: 20.4, endcard: { startS: 18.4, endS: 20.4 } }),
      }),
    });
  });

  it('prefere o compose da MESMA cadeia (revisão + attempt) ao mais recente de outra', async () => {
    composeSteps.unshift({
      id: 'cmp-other',
      type: McStepType.COMPOSE_FFMPEG,
      status: McStepStatus.SUCCEEDED,
      projectRevision: 1,
      attempt: 2,
      outputAssetId: 'composed-other',
      finishedAt: new Date('2026-10-12T11:00:00Z'),
    });
    assets.push({
      id: 'composed-other',
      fileUrl: '/uploads/other.mp4',
      durationMs: 5000,
      metadata: {},
    });
    await fs.writeFile(path.join(uploadsDir, 'other.mp4'), Buffer.from('video'));
    await processor.process({ stepId: 'fin-1' });
    expect(saved[0]).toMatchObject({
      metadata: expect.objectContaining({ composedAssetId: 'composed-asset' }),
    });
  });

  it('sem composição concluída ⇒ failStep (composed_missing), nada publicado, sem e-mail', async () => {
    composeSteps.length = 0;
    await processor.process({ stepId: 'fin-1' });
    expect(pipeline.failStep).toHaveBeenCalledWith(
      step,
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'composed_missing' }),
      expect.objectContaining({ fallbackCode: 'finalize_failed' }),
    );
    expect(ffmpeg.run).not.toHaveBeenCalled();
    expect(pipeline.sendCompletionEmail).not.toHaveBeenCalled();
  });
});
