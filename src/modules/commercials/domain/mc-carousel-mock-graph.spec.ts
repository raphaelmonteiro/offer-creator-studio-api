import { fixtureCarouselScript } from './__fixtures__/mc-offer-carousel.fixtures';
import { syntheticAlignment } from './mc-captions';
import {
  buildMockCarouselPlan,
  fitFontPx,
  MC_MOCK_CAPTION_PAGE_CHARS,
  mockCaptionPages,
  mockDrawtextText,
  mockSlideWindows,
} from './mc-carousel-mock-graph';
import { buildOfferCarouselProps, OfferCarouselProps } from './mc-offer-carousel-props';

function carouselProps(count = 3, captions = true): OfferCarouselProps {
  const script = fixtureCarouselScript(count);
  return buildOfferCarouselProps({
    aspectRatio: '9:16',
    offers: script.offers ?? [],
    lines: script.lines ?? [],
    speeches: (script.lines ?? []).map((line, i) => {
      const scene = script.scenes.find((s) => s.sceneId === line.sceneId)!;
      return {
        sceneId: line.sceneId,
        durationMs: 2000,
        clipUrl: `/uploads/clip-${i}.mp4`,
        alignment: syntheticAlignment(scene.dialogue as string, 2),
      };
    }),
    layoutPreset: 'character_left',
    captions,
    tile: { width: 720, height: 960, url: null },
    characterBackgroundColor: '#FFE082',
    brand: { name: 'Mercadão' },
    assetBaseUrl: 'http://127.0.0.1:3001',
  }).props;
}

/** Tarefa 6.5 — renderizador mock do F2 (ffmpeg): plano puro. */
describe('render mock do F2 — plano ffmpeg (tarefa 6.5)', () => {
  it('dois passes: personagem na janela + TTS (grafo do F1) e cards/cartela; duração = composição', () => {
    const props = carouselProps(3);
    const clips = props.character.clips.map((_, i) => `/tmp/clip-${i}.mp4`);
    const plan = buildMockCarouselPlan({ props, clipPaths: clips, tempDir: '/tmp/job' });
    expect(plan.passes.map((p) => p.label)).toEqual(['speech', 'cards']);
    expect(plan.output).toBe('/tmp/job/carousel.mp4');
    // 5 falas de 2 s + 4 silêncios de 200 ms = 10,8 s; + cartela 1,5 s → 12,3 s (369 quadros)
    expect(plan.expectedDurationMs).toBe(12300);
    const speech = plan.passes[0].args;
    for (const clip of clips) expect(speech).toContain(clip);
    expect(speech.join(' ')).toContain(`overlay=x=${plan.windowPx.x}:y=${plan.windowPx.y}`);
    const cards = plan.passes[1].args.join(' ');
    expect(cards).toContain('tpad=stop_mode=clone:stop_duration=1.5');
    expect(cards).toContain('apad=pad_dur=1.6');
    expect(cards).toContain(
      `drawbox=x=${plan.cardPx.x}:y=${plan.cardPx.y}:w=${plan.cardPx.width}:h=${plan.cardPx.height}`,
    );
    expect(cards).toContain("text='R$ 24,90'");
    expect(cards).toContain("text='de R$ 29,90'");
    expect(cards).toContain("text='OFERTA'");
    expect(cards).toContain("text='R$ 7,99 /un'");
    expect(cards).toContain("text='Mercadão");
    expect(plan.passes[1].args).toEqual(expect.arrayContaining(['-t', '12.3']));
  });

  it('cards entram 0,45 s antes da primeira palavra da fala e ficam até a entrada do seguinte; abertura desde o quadro 0', () => {
    const props = carouselProps(3);
    const slides = mockSlideWindows(props, 12.3);
    expect(slides.map((s) => s.kind)).toEqual(['opening', 'offer', 'offer', 'offer', 'closing']);
    expect(slides[0].startS).toBe(0);
    const firstWord = props.lines[1].words[0].startS;
    expect(slides[1].startS).toBeCloseTo(firstWord - 0.45, 3);
    expect(slides[0].endS).toBe(slides[1].startS);
    expect(slides[1].id).toBe('of-arroz');
    expect(slides[slides.length - 1].endS).toBe(12.3);
  });

  it('legendas por página (≤ 32 caracteres, uma por vez, nunca atravessando falas) só quando ligadas', () => {
    const props = carouselProps(3);
    const pages = mockCaptionPages(props);
    expect(pages.length).toBeGreaterThan(props.lines.length);
    for (const page of pages)
      expect(page.text.length).toBeLessThanOrEqual(MC_MOCK_CAPTION_PAGE_CHARS);
    pages.forEach((page, i) => {
      if (pages[i + 1]) expect(page.endS).toBeLessThanOrEqual(pages[i + 1].startS);
    });
    const withCaptions = buildMockCarouselPlan({
      props,
      clipPaths: props.character.clips.map(() => '/tmp/c.mp4'),
      tempDir: '/tmp/j',
    }).passes[1].args.join(' ');
    const without = carouselProps(3, false);
    const noCaptions = buildMockCarouselPlan({
      props: without,
      clipPaths: without.character.clips.map(() => '/tmp/c.mp4'),
      tempDir: '/tmp/j',
    }).passes[1].args.join(' ');
    expect(withCaptions).toContain('boxcolor=black@0.55');
    expect(noCaptions).not.toContain('boxcolor=black@0.55');
  });

  it('"%" do badge chega ao drawtext com duas barras (senão o ffmpeg o descarta: "Stray %")', () => {
    expect(mockDrawtextText('-18%')).toBe('-18\\\\%');
    expect(mockDrawtextText('Oferta: R$ 9,90')).toBe('Oferta\\: R$ 9,90');
  });

  it('fonte encolhe para caber; um arquivo local por clipe é obrigatório', () => {
    expect(fitFontPx('R$ 24,90', 500, 200)).toBe(100);
    expect(fitFontPx('x'.repeat(80), 400, 80)).toBe(18);
    const props = carouselProps(3);
    expect(() =>
      buildMockCarouselPlan({ props, clipPaths: ['/tmp/a.mp4'], tempDir: '/tmp/j' }),
    ).toThrow(/um arquivo local por clipe/);
  });
});
