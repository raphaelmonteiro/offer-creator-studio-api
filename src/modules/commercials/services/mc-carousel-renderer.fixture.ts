import { fixtureCarouselScript } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { syntheticAlignment } from '../domain/mc-captions';
import { buildOfferCarouselProps, OfferCarouselProps } from '../domain/mc-offer-carousel-props';
import { RemotionModules } from './mc-carousel-renderer';

export function props(): OfferCarouselProps {
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

export function fakeModules(over: Partial<RemotionModules['core']> = {}) {
  const browser = { close: jest.fn().mockResolvedValue(undefined) };
  const cancel = jest.fn();
  const modules = {
    bundler: { bundle: jest.fn().mockResolvedValue('http://localhost:3000/bundle') },
    renderer: {
      openBrowser: jest.fn().mockResolvedValue(browser),
      selectComposition: jest
        .fn()
        .mockResolvedValue({ id: 'OfferCarousel', durationInFrames: 369 }),
      renderMedia: jest.fn(
        async (opts: {
          onProgress?: (p: { progress: number }) => void;
          [key: string]: unknown;
        }) => {
          opts.onProgress?.({ progress: 0.5 });
          opts.onProgress?.({ progress: 1 });
        },
      ),
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

export const request = (p = props()) => ({
  props: p,
  localFiles: {},
  outputPath: '/tmp/out.mp4',
  tempDir: '/tmp',
});
