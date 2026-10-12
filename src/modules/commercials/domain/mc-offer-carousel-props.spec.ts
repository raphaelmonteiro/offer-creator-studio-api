import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fixtureCarouselScript } from './__fixtures__/mc-offer-carousel.fixtures';
import { syntheticAlignment } from './mc-captions';
import {
  absoluteAssetUrl,
  buildOfferCarouselProps,
  carouselCaptionsOf,
  carouselDurationS,
  carouselLayoutPresetOf,
  carouselPresetFractions,
  carouselPrice,
  carouselPropsIssues,
  computeRenderRemotionInputsHash,
  computeRenderRemotionPropsHash,
  McCarouselPropsError,
  OfferCarouselPropsInput,
} from './mc-offer-carousel-props';
import { McAspectRatio, McCarouselLayoutPreset, McScript } from './mc-types';

/** Checkout local do pacote `@chroma/video-templates` (paridade do contrato quando presente). */
const TEMPLATES_DIR =
  process.env.MC_VIDEO_TEMPLATES_DIR ||
  path.resolve(__dirname, '../../../../../../chroma-video-templates');
const CORE_PATH = path.join(TEMPLATES_DIR, 'dist', 'cjs', 'core', 'index.js');
const HAS_PACKAGE = fs.existsSync(CORE_PATH);
const describeWithPackage = HAS_PACKAGE ? describe : describe.skip;

function input(
  script: McScript,
  over: Partial<OfferCarouselPropsInput> = {},
): OfferCarouselPropsInput {
  const lines = script.lines ?? [];
  return {
    aspectRatio: '9:16',
    offers: script.offers ?? [],
    lines,
    speeches: lines.map((line, i) => {
      const scene = script.scenes.find((s) => s.sceneId === line.sceneId)!;
      const durationS = 2 + (i % 3) * 0.5;
      return {
        sceneId: line.sceneId,
        durationMs: durationS * 1000,
        clipUrl: `/uploads/commercials/u1/p1/scenes/${i}/final.mp4`,
        alignment: syntheticAlignment(scene.dialogue as string, durationS),
      };
    }),
    layoutPreset: 'character_left',
    captions: true,
    tile: { width: 720, height: 960, url: '/uploads/commercials/kits/tile.png' },
    characterBackgroundColor: '#ffe082',
    brand: { logoUrl: '/uploads/logos/mercadao.png', name: 'Mercadão' },
    assetBaseUrl: 'http://127.0.0.1:3001',
    ...over,
  };
}

describe('props da composição OfferCarousel (tarefa 6.5)', () => {
  const script = fixtureCarouselScript(4);

  it('timeline = durações medidas + 200 ms entre falas; palavras do TTS deslocadas para o início da fala; tempos absolutos', () => {
    const { props, timeline } = buildOfferCarouselProps(input(script));
    expect(props).toMatchObject({ width: 1080, height: 1920, fps: 30, captions: true });
    expect(props.lines.map((l) => [l.kind, l.startS, l.endS])).toEqual([
      ['opening', 0, 2],
      ['offer', 2.2, 4.7],
      ['offer', 4.9, 7.9],
      ['offer', 8.1, 10.1],
      ['offer', 10.3, 12.8],
      ['closing', 13, 16],
    ]);
    expect(props.lines[1]).toMatchObject({ id: script.scenes[1].sceneId, offerId: 'of-arroz' });
    expect(props.lines[0].offerId).toBeUndefined();
    // palavras dentro da janela da fala, em ordem, absolutas
    for (const line of props.lines) {
      expect(line.words.length).toBeGreaterThan(0);
      expect(line.words[0].startS).toBeGreaterThanOrEqual(line.startS);
      expect(line.words[line.words.length - 1].endS).toBeLessThanOrEqual(line.endS);
    }
    expect(props.lines[1].words[0]).toMatchObject({ text: 'Arroz', startS: 2.2 });
    // clipes conformados na ordem, com URL absoluta e a fala de origem
    expect(props.character.clips[1]).toEqual({
      src: 'http://127.0.0.1:3001/uploads/commercials/u1/p1/scenes/1/final.mp4',
      startS: 2.2,
      endS: 4.7,
      lineId: script.scenes[1].sceneId,
    });
    expect(timeline).toEqual({
      speechEndS: 16,
      totalS: 17.5, // + cartela de 1,5 s da composição
      scenes: props.lines.map((l) => ({ sceneId: l.id, startS: l.startS, endS: l.endS })),
    });
    expect(carouselDurationS(props)).toBe(17.5);
  });

  it('ofertas no contrato: preço "24,90" sem R$, preço anterior/unidade/badge opcionais, foto absoluta, catalogId', () => {
    const { props } = buildOfferCarouselProps(input(script));
    expect(props.offers[0]).toEqual({
      id: 'of-arroz',
      name: 'Arroz Branco Tipo 1 5 kg',
      price: '24,90',
      originalPrice: '29,90',
      badge: 'OFERTA',
      imageUrl: 'http://127.0.0.1:3001/uploads/products/arroz.png',
      catalogId: '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
    });
    expect(props.offers[2]).toEqual(expect.objectContaining({ unit: 'un', price: '7,99' }));
    expect(props.offers[2]).not.toHaveProperty('originalPrice');
    expect(props.offers[2]).not.toHaveProperty('badge');
    expect(props.brand).toEqual({
      logoUrl: 'http://127.0.0.1:3001/uploads/logos/mercadao.png',
      name: 'Mercadão',
      primaryColor: '#C62828',
      secondaryColor: '#FFD54F',
      fontFamily: 'DejaVu Sans',
    });
    expect(props.character).toMatchObject({
      tileRatio: 0.75,
      posterUrl: 'http://127.0.0.1:3001/uploads/commercials/kits/tile.png',
      backgroundColor: '#FFE082',
    });
    expect(carouselPrice('R$ 8,9')).toBe('8,90');
    expect(carouselPrice('1299,9')).toBe('1.299,90');
    expect(carouselPrice('24')).toBe('24,00');
    expect(carouselPrice('vinte')).toBeNull();
    expect(absoluteAssetUrl('https://cdn/x.png', 'http://h')).toBe('https://cdn/x.png');
    expect(absoluteAssetUrl('uploads/x.png', 'http://h/')).toBe('http://h/uploads/x.png');
  });

  it('janela e caixa dos cards vêm do preset (port fiel de presetFractions 0.1.0 — mesma janela da fixture do pacote)', () => {
    const { props } = buildOfferCarouselProps(input(script));
    expect(props.character.window).toEqual({ x: 0.0602, y: 0.3865, w: 0.3518, h: 0.2635 });
    expect(props.cardBox).toBeUndefined(); // default = a do preset
    expect(
      carouselPresetFractions({
        width: 1080,
        height: 1920,
        tileRatio: 0.75,
        preset: 'character_left',
        captions: true,
      }),
    ).toEqual({
      window: { x: 0.0602, y: 0.3865, w: 0.3518, h: 0.2635 },
      cardBox: { x: 0.4343, y: 0.2344, w: 0.5055, h: 0.4119 },
      captions: { x: 0.0602, y: 0.1402, w: 0.8796, h: 0.078 },
    });
    expect(carouselPropsIssues(props)).toEqual([]);
  });

  it('dados fora do contrato falham antes do render: falas × clipes, oferta sem foto, preço ilegível', () => {
    const base = input(script);
    expect(() => buildOfferCarouselProps({ ...base, speeches: base.speeches.slice(1) })).toThrow(
      McCarouselPropsError,
    );
    const swapped = {
      ...base,
      speeches: [base.speeches[1], base.speeches[0], ...base.speeches.slice(2)],
    };
    expect(() => buildOfferCarouselProps(swapped)).toThrow(/não corresponde/);
    try {
      buildOfferCarouselProps({
        ...base,
        offers: base.offers.map((o, i) => (i === 1 ? { ...o, imageUrl: null } : o)),
      });
      fail('esperava erro');
    } catch (err) {
      expect((err as McCarouselPropsError).code).toBe('OFFER_IMAGE_REQUIRED');
    }
    expect(() =>
      buildOfferCarouselProps({
        ...base,
        offers: base.offers.map((o, i) => (i === 0 ? { ...o, price: 'grátis' } : o)),
      }),
    ).toThrow(/preço ilegível/);
  });

  it('validação local aponta o card fora da área segura (1080×1920 abaixo de y 1248; 1080×1350 a 40 px da borda)', () => {
    const { props } = buildOfferCarouselProps(input(script));
    const low = { ...props, cardBox: { x: 0.45, y: 0.5, w: 0.5, h: 0.2 } }; // fundo em 1344 px
    const issues = carouselPropsIssues(low);
    expect(
      issues.filter((i) => i.code === 'ELEMENT_OUTSIDE_SAFE_AREA').map((i) => i.elementId),
    ).toEqual(['of-arroz', 'of-cafe', 'of-oleo', 'of-leite']);
    const feed = buildOfferCarouselProps(input(script, { aspectRatio: '4:5' })).props;
    expect(carouselPropsIssues(feed)).toEqual([]);
    const nearRight = { ...feed, cardBox: { x: 0.5, y: 0.2, w: (1080 - 40) / 1080 - 0.5, h: 0.4 } };
    expect(carouselPropsIssues(nearRight)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ELEMENT_OUTSIDE_SAFE_AREA', element: 'card' }),
      ]),
    );
  });

  it('preset e legendas: roteiro > projeto > default; legendas do roteiro > opção do projeto', () => {
    expect(
      carouselLayoutPresetOf(
        { layoutPreset: 'character_bottom' },
        { layoutPreset: 'character_right' },
      ),
    ).toBe('character_bottom');
    expect(carouselLayoutPresetOf({}, { layoutPreset: 'character_right' })).toBe('character_right');
    expect(carouselLayoutPresetOf(null, { layoutPreset: 'lower_right' })).toBe('character_left');
    expect(carouselCaptionsOf({ captions: false }, { captionsEnabled: true })).toBe(false);
    expect(carouselCaptionsOf({}, { captionsEnabled: true })).toBe(true);
  });

  it('render determinístico: mesmas props ⇒ mesmo hash; foto, ordem, versão da composição e renderizador mudam o hash', () => {
    const { props } = buildOfferCarouselProps(input(script));
    const hash = (
      p = props,
      compositionVersion = '0.1.0',
      renderer: 'remotion' | 'mock' = 'remotion',
    ) => computeRenderRemotionPropsHash({ props: p, compositionVersion, renderer });
    expect(hash(JSON.parse(JSON.stringify(props)))).toBe(hash());
    const photo = {
      ...props,
      offers: props.offers.map((o, i) => (i === 0 ? { ...o, imageUrl: 'http://x/y.png' } : o)),
    };
    expect(hash(photo)).not.toBe(hash());
    expect(hash(props, '0.2.0')).not.toBe(hash());
    expect(hash(props, '0.1.0', 'mock')).not.toBe(hash());

    // hash das ENTRADAS (materialização): ordem das ofertas e foto mudam; nada de trilha aqui
    const inputsHash = (s: McScript, over: Record<string, unknown> = {}) =>
      computeRenderRemotionInputsHash({
        clips: s.scenes.map((sc) => ({
          sceneId: sc.sceneId as string,
          finalAssetId: `f-${sc.sceneId}`,
          audioAssetId: `a-${sc.sceneId}`,
        })),
        offers: s.offers ?? [],
        lines: s.lines ?? [],
        aspectRatio: '9:16',
        layoutPreset: 'character_left',
        captions: true,
        tileAssetId: 'tile-1',
        characterBackgroundColor: '#ffe082',
        brandName: 'Mercadão',
        gapMs: 200,
        compositionVersion: '0.1.0',
        renderer: 'remotion',
        ...over,
      });
    const base = inputsHash(script);
    expect(inputsHash(script, { characterBackgroundColor: '#FFE082' })).toBe(base);
    expect(inputsHash(script, { layoutPreset: 'character_right' })).not.toBe(base);
    expect(
      inputsHash({
        ...script,
        offers: script.offers?.map((o, i) => (i ? o : { ...o, badge: 'NOVO' })),
      }),
    ).not.toBe(base);
  });
});

/**
 * Avalia funções do núcleo do pacote num `node` à parte (o checkout local é
 * JS compilado fora do rootDir — sem passar pelo transform do jest).
 */
function runCore(calls: Array<{ fn: string; args: unknown[] }>): unknown[] {
  const script =
    `const core = require(${JSON.stringify(CORE_PATH)});` +
    `const calls = JSON.parse(require('fs').readFileSync(0, 'utf8'));` +
    `process.stdout.write(JSON.stringify(calls.map((c) => core[c.fn](...c.args))));`;
  const out = spawnSync(process.execPath, ['-e', script], {
    input: JSON.stringify(calls),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout) as unknown[];
}

describeWithPackage('paridade com o pacote @chroma/video-templates (checkout local)', () => {
  it('props montadas passam no schema, no validateLayout e no captionsReadiness do pacote; duração igual', () => {
    const cases: Array<{ props: ReturnType<typeof buildOfferCarouselProps>['props'] }> = [];
    for (const count of [3, 4, 6]) {
      for (const aspectRatio of ['9:16', '4:5', '1:1', '16:9'] as McAspectRatio[]) {
        for (const layoutPreset of [
          'character_left',
          'character_right',
          'character_bottom',
        ] as McCarouselLayoutPreset[]) {
          const s = fixtureCarouselScript(count);
          cases.push(buildOfferCarouselProps(input(s, { aspectRatio, layoutPreset })));
        }
      }
    }
    const results = runCore(
      cases.flatMap(({ props }) => [
        { fn: 'parseOfferCarouselProps', args: [props] },
        { fn: 'validateLayout', args: [props] },
        { fn: 'captionsReadiness', args: [props] },
        { fn: 'computeDurationInFrames', args: [props] },
      ]),
    );
    cases.forEach(({ props }, i) => {
      const [parsed, layout, readiness, frames] = results.slice(i * 4, i * 4 + 4) as [
        { success: boolean },
        unknown[],
        { ok: boolean },
        number,
      ];
      expect(parsed).toMatchObject({ success: true });
      // todo preset cabe na área segura (pacote) e o validador local concorda
      expect(layout).toEqual([]);
      expect(carouselPropsIssues(props)).toEqual([]);
      expect(readiness).toMatchObject({ ok: true });
      expect(carouselDurationS(props)).toBeCloseTo(frames / 30, 3);
    });
  });

  it('o port de presetFractions bate com o do pacote em todos os tamanhos, presets e tiles', () => {
    const args: Array<Parameters<typeof carouselPresetFractions>[0]> = [];
    for (const [width, height] of [
      [1080, 1920],
      [1080, 1350],
      [1080, 1080],
      [1920, 1080],
    ]) {
      for (const preset of ['character_left', 'character_right', 'character_bottom']) {
        for (const tileRatio of [0.75, 1, 0.6]) {
          for (const captions of [true, false]) {
            args.push({
              width,
              height,
              tileRatio,
              preset: preset as McCarouselLayoutPreset,
              captions,
            });
          }
        }
      }
    }
    const results = runCore(args.map((a) => ({ fn: 'presetFractions', args: [a] })));
    args.forEach((a, i) => expect(carouselPresetFractions(a)).toEqual(results[i]));
  });

  it('sem timestamps numa fala com legendas, o pacote acusa CAPTIONS_ALIGNMENT_MISSING (a aprovação já bloqueia antes)', () => {
    const base = input(fixtureCarouselScript(3));
    const { props } = buildOfferCarouselProps({
      ...base,
      speeches: base.speeches.map((s, i) => (i === 2 ? { ...s, alignment: null } : s)),
    });
    const [readiness] = runCore([{ fn: 'captionsReadiness', args: [props] }]);
    expect(readiness).toMatchObject({ ok: false, code: 'CAPTIONS_ALIGNMENT_MISSING' });
  });
});
