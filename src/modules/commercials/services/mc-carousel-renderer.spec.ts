import * as fs from 'fs';
import * as path from 'path';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { fixtureCarouselScript } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { syntheticAlignment } from '../domain/mc-captions';
import { buildOfferCarouselProps, OfferCarouselProps } from '../domain/mc-offer-carousel-props';
import {
  MC_QUEUE_CONCURRENCY,
  MC_STEP_QUEUE,
  mcExpireForQueue,
} from '../domain/mc-pipeline.config';
import {
  mcCarouselRendererKind,
  mcCompositionVersion,
  mcRenderAssetBaseUrl,
  mcRenderTimeouts,
} from '../domain/mc-render.config';
import { McStepType } from '../domain/mc-types';
import {
  loadRemotionModules,
  McCarouselRendererService,
  MockCarouselRenderer,
  RemotionCarouselRenderer,
  RemotionModules,
} from './mc-carousel-renderer';

function props(): OfferCarouselProps {
  const script = fixtureCarouselScript(3);
  return buildOfferCarouselProps({
    aspectRatio: '9:16',
    offers: script.offers ?? [],
    lines: script.lines ?? [],
    speeches: (script.lines ?? []).map((line, i) => ({
      sceneId: line.sceneId,
      durationMs: 2000,
      clipUrl: `/uploads/clip-${i}.mp4`,
      alignment: syntheticAlignment('fala de teste', 2),
    })),
    layoutPreset: 'character_left',
    captions: true,
    tile: { width: 720, height: 960, url: null },
    characterBackgroundColor: null,
    brand: {},
    assetBaseUrl: 'http://127.0.0.1:3001',
  }).props;
}

function fakeModules(over: Partial<RemotionModules['core']> = {}) {
  const browser = { close: jest.fn().mockResolvedValue(undefined) };
  const cancel = jest.fn();
  const modules = {
    bundler: { bundle: jest.fn().mockResolvedValue('http://localhost:3000/bundle') },
    renderer: {
      openBrowser: jest.fn().mockResolvedValue(browser),
      selectComposition: jest
        .fn()
        .mockResolvedValue({ id: 'OfferCarousel', durationInFrames: 369 }),
      renderMedia: jest.fn(async (opts: { onProgress?: (p: { progress: number }) => void }) => {
        opts.onProgress?.({ progress: 0.5 });
        opts.onProgress?.({ progress: 1 });
      }),
      makeCancelSignal: jest.fn(() => ({ cancelSignal: { token: 1 }, cancel })),
    },
    core: {
      COMPOSITION_VERSION: '0.1.0',
      OFFER_CAROUSEL_COMPOSITION_ID: 'OfferCarousel',
      parseOfferCarouselProps: jest.fn(() => ({ success: true as const, data: {} })),
      validateLayout: jest.fn(() => []),
      captionsReadiness: jest.fn(() => ({ ok: true, code: null })),
      ...over,
    },
    entryPoint: '/pkg/src/index.ts',
  };
  return { modules: modules as unknown as RemotionModules & typeof modules, browser, cancel };
}

const request = (p = props()) => ({
  props: p,
  localFiles: {},
  outputPath: '/tmp/out.mp4',
  tempDir: '/tmp',
});

/** Tarefa 6.5 — step `render_remotion`: fila, prazos e renderizadores. */
describe('render_remotion — fila mc.render e configuração (tarefa 6.5)', () => {
  it('fila própria com concorrência 1 e expiração de 900 s (diferente do default de 120 s)', () => {
    expect(MC_STEP_QUEUE[McStepType.RENDER_REMOTION]).toBe(QUEUES.MC_RENDER);
    expect(QUEUES.MC_RENDER).toBe('mc.render');
    expect(MC_QUEUE_CONCURRENCY[QUEUES.MC_RENDER]).toBe(1);
    expect(mcExpireForQueue(QUEUES.MC_RENDER)).toBe(900);
    expect(mcExpireForQueue(QUEUES.MC_RENDER)).not.toBe(
      mcExpireForQueue('mc.desconhecida' as never),
    );
    const { delayRenderTimeoutMs, totalTimeoutMs } = mcRenderTimeouts();
    expect(totalTimeoutMs).toBeLessThan(900_000); // falha por failStep antes do job expirar
    expect(delayRenderTimeoutMs).toBeLessThan(totalTimeoutMs);
  });

  it('env: versão da composição (default 0.1.0), base das URLs (default 127.0.0.1:3001) e renderizador por provider', () => {
    expect(mcCompositionVersion({})).toBe('0.1.0');
    expect(mcCompositionVersion({ MC_COMPOSITION_VERSION: '0.2.0' })).toBe('0.2.0');
    expect(mcRenderAssetBaseUrl({})).toBe('http://127.0.0.1:3001');
    expect(mcRenderAssetBaseUrl({ MC_RENDER_ASSET_BASE_URL: 'http://backend:3001/' })).toBe(
      'http://backend:3001',
    );
    expect(mcCarouselRendererKind({})).toBe('mock');
    expect(mcCarouselRendererKind({ MC_PIPELINE_PROVIDER: 'mock' })).toBe('mock');
    expect(mcCarouselRendererKind({ MC_PIPELINE_PROVIDER: 'real' })).toBe('remotion');
    expect(
      mcCarouselRendererKind({ MC_PIPELINE_PROVIDER: 'mock', MC_CAROUSEL_RENDERER: 'remotion' }),
    ).toBe('remotion');
  });

  it('McCarouselRendererService: mock com o pipeline mock, Remotion com o real; uma instância por processo', () => {
    const service = new McCarouselRendererService({} as FfmpegRunner);
    const mock = service.current({ MC_PIPELINE_PROVIDER: 'mock' });
    expect(mock).toBeInstanceOf(MockCarouselRenderer);
    expect(service.current({ MC_PIPELINE_PROVIDER: 'mock' })).toBe(mock);
    const remotion = service.current({ MC_PIPELINE_PROVIDER: 'real' });
    expect(remotion).toBeInstanceOf(RemotionCarouselRenderer);
    expect(service.current({ MC_PIPELINE_PROVIDER: 'real' })).toBe(remotion);
  });
});

describe('RemotionCarouselRenderer (tarefa 6.5)', () => {
  const env = { MC_RENDER_BROWSER: '/usr/bin/chromium-browser' };

  it('pacotes ausentes → erro TERMINAL RENDER_UNAVAILABLE (o backend roda sem eles)', async () => {
    await expect(
      loadRemotionModules({ MC_VIDEO_TEMPLATES_DIR: '/nao/existe/video-templates' }),
    ).rejects.toMatchObject({ code: 'RENDER_UNAVAILABLE' });
    const err = await loadRemotionModules({}).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalProviderError);
    expect((err as TerminalProviderError).code).toBe('RENDER_UNAVAILABLE');
    const renderer = new RemotionCarouselRenderer(env, () =>
      loadRemotionModules({ MC_VIDEO_TEMPLATES_DIR: '/nao/existe' }),
    );
    await expect(renderer.render(request())).rejects.toMatchObject({ code: 'RENDER_UNAVAILABLE' });
  });

  const templatesDir =
    process.env.MC_VIDEO_TEMPLATES_DIR ||
    path.resolve(__dirname, '../../../../../../chroma-video-templates');
  const itWithPackage = fs.existsSync(path.join(templatesDir, 'package.json')) ? it : it.skip;

  itWithPackage(
    'checkout local (MC_VIDEO_TEMPLATES_DIR): import() dinâmico do bundler e do renderer DO pacote, núcleo CJS e entrada remotionEntry',
    async () => {
      const imported: string[] = [];
      const modules = await loadRemotionModules(
        { MC_VIDEO_TEMPLATES_DIR: templatesDir },
        async (specifier) => {
          imported.push(specifier);
          return { specifier };
        },
      );
      expect(imported).toHaveLength(3);
      expect(imported[0]).toContain(
        path.join(templatesDir, 'node_modules', '@remotion', 'bundler'),
      );
      expect(imported[1]).toContain(
        path.join(templatesDir, 'node_modules', '@remotion', 'renderer'),
      );
      expect(imported[2]).toBe(path.join(templatesDir, 'dist', 'cjs', 'core', 'index.js'));
      expect(modules.entryPoint).toBe(path.join(templatesDir, 'src', 'index.ts'));
    },
  );

  it('bundle UMA vez por processo (enableCaching: false), navegador aberto UMA vez com MC_RENDER_BROWSER, render com concorrência 1', async () => {
    const { modules, cancel } = fakeModules();
    const renderer = new RemotionCarouselRenderer(env, async () => modules);
    const p = props();
    const progress: number[] = [];
    const first = await renderer.render({
      ...request(p),
      onProgress: (pct) => void progress.push(pct),
    });
    await renderer.render(request(p));
    expect(first).toEqual({
      outputPath: '/tmp/out.mp4',
      renderer: 'remotion',
      compositionVersion: '0.1.0',
    });
    expect(modules.bundler.bundle).toHaveBeenCalledTimes(1);
    expect(modules.bundler.bundle).toHaveBeenCalledWith({
      entryPoint: '/pkg/src/index.ts',
      enableCaching: false,
    });
    expect(modules.renderer.openBrowser).toHaveBeenCalledTimes(1);
    expect(modules.renderer.openBrowser).toHaveBeenCalledWith('chrome', {
      browserExecutable: '/usr/bin/chromium-browser',
    });
    expect(modules.renderer.selectComposition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'OfferCarousel',
        inputProps: p,
        serveUrl: 'http://localhost:3000/bundle',
      }),
    );
    const call = modules.renderer.renderMedia.mock.calls[0][0] as Record<string, unknown>;
    expect(call).toMatchObject({
      codec: 'h264',
      concurrency: 1,
      outputLocation: '/tmp/out.mp4',
      inputProps: p,
      cancelSignal: { token: 1 },
    });
    expect(call.timeoutInMilliseconds as number).toBeLessThan(900_000);
    expect(progress).toEqual([50, 100]);
    expect(cancel).not.toHaveBeenCalled();
    // as props são revalidadas pelo pacote antes do render
    expect(modules.core.parseOfferCarouselProps).toHaveBeenCalledWith(p);
    expect(modules.core.validateLayout).toHaveBeenCalledWith(p);
    expect(modules.core.captionsReadiness).toHaveBeenCalledWith(p);
  });

  it('layout recusado pelo pacote → CAROUSEL_LAYOUT_INVALID apontando o card; legendas sem timestamps → CAPTIONS_ALIGNMENT_MISSING; nada é renderizado', async () => {
    const layout = fakeModules({
      validateLayout: jest.fn(() => [
        { code: 'ELEMENT_OUTSIDE_SAFE_AREA', elementId: 'of-arroz', message: 'card fora' },
      ]),
    });
    const r1 = new RemotionCarouselRenderer(env, async () => layout.modules);
    await expect(r1.render(request())).rejects.toMatchObject({
      code: 'CAROUSEL_LAYOUT_INVALID',
      message: expect.stringContaining('ELEMENT_OUTSIDE_SAFE_AREA:of-arroz'),
    });
    expect(layout.modules.renderer.renderMedia).not.toHaveBeenCalled();
    const captions = fakeModules({
      captionsReadiness: jest.fn(() => ({
        ok: false,
        code: 'CAPTIONS_ALIGNMENT_MISSING',
        message: 'sem',
      })),
    });
    const r2 = new RemotionCarouselRenderer(env, async () => captions.modules);
    await expect(r2.render(request())).rejects.toMatchObject({
      code: 'CAPTIONS_ALIGNMENT_MISSING',
    });
    const schema = fakeModules({
      parseOfferCarouselProps: jest.fn(() => ({
        success: false as const,
        issues: [{ path: 'offers', message: 'x' }],
      })) as never,
    });
    const r3 = new RemotionCarouselRenderer(env, async () => schema.modules);
    await expect(r3.render(request())).rejects.toMatchObject({ code: 'CAROUSEL_PROPS_INVALID' });
  });

  it('sem MC_RENDER_BROWSER → RENDER_UNAVAILABLE (o preflight continua exigindo o navegador)', async () => {
    const { modules } = fakeModules();
    const renderer = new RemotionCarouselRenderer({}, async () => modules);
    await expect(renderer.render(request())).rejects.toMatchObject({ code: 'RENDER_UNAVAILABLE' });
    expect(modules.renderer.openBrowser).not.toHaveBeenCalled();
  });

  it('falha no meio do render fecha o navegador e o próximo job abre outro', async () => {
    const { modules, browser } = fakeModules();
    modules.renderer.renderMedia.mockRejectedValueOnce(new Error('Target closed'));
    const renderer = new RemotionCarouselRenderer(env, async () => modules);
    await expect(renderer.render(request())).rejects.toThrow('Target closed');
    expect(browser.close).toHaveBeenCalled();
    await renderer.render(request());
    expect(modules.renderer.openBrowser).toHaveBeenCalledTimes(2);
    expect(modules.bundler.bundle).toHaveBeenCalledTimes(1);
  });
});

describe('MockCarouselRenderer (tarefa 6.5)', () => {
  it('layout inválido falha antes do ffmpeg; clipe sem arquivo local também', async () => {
    const run = jest.fn();
    const mock = new MockCarouselRenderer({ run } as unknown as FfmpegRunner);
    const p = props();
    await expect(
      mock.render(request({ ...p, cardBox: { x: 0, y: 0, w: 1, h: 1 } })),
    ).rejects.toMatchObject({ code: 'CAROUSEL_LAYOUT_INVALID' });
    await expect(mock.render(request(p))).rejects.toMatchObject({ code: 'scene_asset_missing' });
    expect(run).not.toHaveBeenCalled();
  });
});
