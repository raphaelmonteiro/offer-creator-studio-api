import { fixtureTalkTileScript } from './__fixtures__/mc-script-v2.fixtures';
import {
  buildDirectorJsonSchemaF1,
  buildDirectorSystemPromptF1,
  buildMockNarrationF1,
  buildMockScriptF1,
  buildProductsSnapshot,
  buildTalkingArtScript,
  chunkNarration,
  clampNarration,
  DirectorF1Context,
  matchCitedOffer,
  normalizeDirectorScenesV2,
  splitSentences,
} from './mc-director';
import { numeroPorExtenso, parsePreco, precoPorExtenso } from './mc-preco-extenso';
import { MC_EMPTY_QUALITY, resolveQuality } from './mc-quality';
import { validateScriptV2 } from './mc-script-v2';
import { estimateSpeechSecondsRaw } from './mc-speech-estimate';
import { defaultCharacterWindow, isWindowWellFormed, safeAreaFor } from './mc-talking-art-window';
import {
  MC_TALKING_ART_MAX_OFFERS,
  MC_TALKING_ART_NARRATION_MAX_CHARS,
  MC_TALKING_ART_NARRATION_MIN_CHARS,
  McScript,
  McSealProduct,
} from './mc-types';

let seq = 0;
const ids = () => `id-${++seq}`;

/** Arte de 12 ofertas (spec "Arte com 12 ofertas"): nomes e preços variados, com acentos. */
const TWELVE_OFFERS: McSealProduct[] = [
  { name: 'Arroz Tio João Integral 5kg', price: '24,90', unit: 'pct' },
  { name: 'Feijão Carioca Tipo 1', price: '8,99', unit: 'kg' },
  { name: 'Pão Francês Crocante', price: '0,79', unit: 'un' },
  { name: 'Leite Integral Caixa 1L', price: '4,49', unit: 'un' },
  { name: 'Café Torrado e Moído 500g', price: '18,90', unit: 'pct' },
  { name: 'Açúcar Refinado 1kg', price: '3,99', unit: 'kg' },
  { name: 'Óleo de Soja 900ml', price: '6,49', unit: 'un' },
  { name: 'Macarrão Espaguete 500g', price: '4,29', unit: 'pct' },
  { name: 'Refrigerante Cola 2L', price: '7,99', unit: 'un' },
  { name: 'Sabão em Pó 1kg', price: '12,90', unit: 'cx' },
  { name: 'Papel Higiênico 12 rolos', price: '19,90', unit: 'pct' },
  { name: 'Banana Prata', price: '5,99', unit: 'kg' },
];

function ctxWith(
  products: McSealProduct[],
  over: Partial<DirectorF1Context> = {},
): DirectorF1Context {
  return {
    products: buildProductsSnapshot(products, ids, MC_TALKING_ART_MAX_OFFERS),
    storeName: 'Mercado do Zé',
    maxChunkS: 15,
    frame: { width: 1080, height: 1920 },
    tile: { width: 720, height: 960 },
    logoFace: false,
    logoBox: null,
    ...over,
  };
}

describe('preço por extenso (pt-BR) — o diretor F1 fala preços, nunca "9,99"', () => {
  it('parsePreco aceita R$, milhar com ponto e centavos com 1 ou 2 dígitos', () => {
    expect(parsePreco('24,90')).toEqual({ reais: 24, centavos: 90 });
    expect(parsePreco('R$ 1.299,90')).toEqual({ reais: 1299, centavos: 90 });
    expect(parsePreco('0,79')).toEqual({ reais: 0, centavos: 79 });
    expect(parsePreco('24')).toEqual({ reais: 24, centavos: 0 });
    expect(parsePreco('9,9')).toEqual({ reais: 9, centavos: 90 });
    expect(parsePreco('abc')).toBeNull();
  });

  it('numeroPorExtenso cobre unidades, dezenas, centenas e milhares', () => {
    expect(numeroPorExtenso(0)).toBe('zero');
    expect(numeroPorExtenso(16)).toBe('dezesseis');
    expect(numeroPorExtenso(24)).toBe('vinte e quatro');
    expect(numeroPorExtenso(100)).toBe('cem');
    expect(numeroPorExtenso(101)).toBe('cento e um');
    expect(numeroPorExtenso(999)).toBe('novecentos e noventa e nove');
    expect(numeroPorExtenso(1000)).toBe('mil');
    expect(numeroPorExtenso(1299)).toBe('mil duzentos e noventa e nove');
    expect(numeroPorExtenso(2020)).toBe('dois mil e vinte');
  });

  it('precoPorExtenso: reais e centavos, singular/plural, só centavos, ilegível volta o texto', () => {
    expect(precoPorExtenso('24,90')).toBe('vinte e quatro reais e noventa centavos');
    expect(precoPorExtenso('R$ 1,00')).toBe('um real');
    expect(precoPorExtenso('0,79')).toBe('setenta e nove centavos');
    expect(precoPorExtenso('8,99')).toBe('oito reais e noventa e nove centavos');
    expect(precoPorExtenso('1.299,01')).toBe('mil duzentos e noventa e nove reais e um centavo');
    expect(precoPorExtenso('0,00')).toBe('zero reais');
    expect(precoPorExtenso('grátis')).toBe('grátis');
  });
});

describe('diretor F1 — prompt, schema e divisão da narração (tarefa 4.1, D6/D7)', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('system prompt F1: 6–25 s, até 3 ofertas por extenso, convite, 90–375 caracteres, limite do motor por frase', () => {
    const prompt = buildDirectorSystemPromptF1({
      products: buildProductsSnapshot(TWELVE_OFFERS, ids, MC_TALKING_ART_MAX_OFFERS),
      storeName: 'Mercado do Zé',
      maxChunkS: 15,
    });
    expect(prompt).toMatch(/de 6 a 25 segundos/);
    expect(prompt).toMatch(/NO MÁXIMO 3 ofertas/);
    expect(prompt).toMatch(/por extenso/);
    expect(prompt).toMatch(/Convide o público a ver as demais ofertas/);
    expect(prompt).toMatch(/entre 90 e 375 caracteres/);
    expect(prompt).toMatch(/no máximo 15 segundos/);
    expect(prompt).toMatch(/\[0\] Arroz Tio João Integral 5kg \(R\$ 24,90 \/ pct\)/);
    expect(prompt).toMatch(/\[11\] Banana Prata/);
    expect(prompt).toMatch(/Mercado do Zé/);
    const schema = buildDirectorJsonSchemaF1() as {
      strict: boolean;
      schema: { required: string[]; properties: { citedOfferIndexes: { maxItems: number } } };
    };
    expect(schema.strict).toBe(true);
    expect(schema.schema.required).toEqual(['narration', 'citedOfferIndexes']);
    expect(schema.schema.properties.citedOfferIndexes.maxItems).toBe(3);
  });

  it('splitSentences preserva pontuação e ignora vazios; chunkNarration divide por frase sob maxChunkS', () => {
    expect(splitSentences('Olá! Chegaram as ofertas. Corra e aproveite!')).toEqual([
      'Olá!',
      'Chegaram as ofertas.',
      'Corra e aproveite!',
    ]);
    const sentence = (n: number) => `${'frase bem comprida '.repeat(n).trim()}.`; // 20 chars por repetição
    const narration = [sentence(5), sentence(5), sentence(5), sentence(5)].join(' '); // 4 × ~100 chars ≈ 6,7 s cada
    const chunks = chunkNarration(narration, 15);
    // 15 s ≈ 225 chars: cabem 2 frases por fala → 2 falas de 2 frases
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => estimateSpeechSecondsRaw(c) <= 15)).toBe(true);
    expect(chunks.join(' ')).toBe(narration);
    // maxChunkS menor força 3 falas no máximo (D6: 1 a 3) — o resto é fundido na última
    expect(chunkNarration(narration, 7)).toHaveLength(3);
    // frase isolada acima do limite é quebrada na vírgula
    const long = `${'parte um bem comprida, '.repeat(6)}parte final.`; // > 7 s
    const pieces = chunkNarration(long, 7);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(' ')).toBe(long);
  });

  it('clampNarration corta no fim de frase ao passar do teto e mantém textos curtos', () => {
    const short =
      'Olá! Chegaram as ofertas da semana no mercado. Corra e aproveite as promoções de hoje!';
    expect(clampNarration(short)).toBe(short);
    const long = `${'Uma frase de tamanho médio para a fala. '.repeat(12)}`.trim();
    const clamped = clampNarration(long);
    expect(clamped.length).toBeLessThanOrEqual(MC_TALKING_ART_NARRATION_MAX_CHARS);
    expect(clamped.endsWith('.')).toBe(true);
  });

  it('matchCitedOffer liga o trecho à oferta pelo nome (sem acento/caixa); trecho sem oferta → null', () => {
    const products = buildProductsSnapshot(TWELVE_OFFERS, ids);
    expect(matchCitedOffer('Feijao carioca por oito reais!', products)).toBe(products[1].id);
    expect(matchCitedOffer('Corra e aproveite!', products)).toBeNull();
  });

  it('fixture de 12 ofertas: a narração cita até 3, tem 90–375 caracteres e vira 1 a 3 cenas talk_tile válidas', () => {
    const ctx = ctxWith(TWELVE_OFFERS);
    const raw = buildMockNarrationF1({ products: ctx.products, storeName: ctx.storeName });
    expect(raw.citedOfferIndexes.length).toBeLessThanOrEqual(3);
    expect(raw.narration.length).toBeGreaterThanOrEqual(MC_TALKING_ART_NARRATION_MIN_CHARS);
    expect(raw.narration.length).toBeLessThanOrEqual(MC_TALKING_ART_NARRATION_MAX_CHARS);
    expect(raw.narration).toMatch(/vinte e quatro reais e noventa centavos/);
    expect(raw.narration).not.toMatch(/\d,\d{2}/); // nunca "24,90"
    expect(raw.narration).toMatch(/muito mais oferta/); // convite a ver as demais

    const script = buildTalkingArtScript(raw, ctx, ids);
    expect(script).toMatchObject({ schemaVersion: 2, format: 'talking_art', logoFace: false });
    expect(script.citedOfferIds).toHaveLength(3);
    expect(script.citedOfferIds!.every((id) => ctx.products.some((p) => p.id === id))).toBe(true);
    expect(script.scenes.length).toBeGreaterThanOrEqual(1);
    expect(script.scenes.length).toBeLessThanOrEqual(3);
    expect(script.scenes.every((s) => s.sceneType === 'talk_tile')).toBe(true);
    expect(script.scenes.every((s) => !!s.sceneId && !!s.dialogue && s.durationS >= 3)).toBe(true);
    expect(script.scenes.map((s) => s.idx)).toEqual(script.scenes.map((_, i) => i));
    expect(
      script.scenes.every((s) => s.initialFrame === undefined && s.environmentId === null),
    ).toBe(true);
    expect(script.scenes.every((s) => s.sealCue === null)).toBe(true);
    expect(script.scenes.map((s) => s.dialogue).join(' ')).toBe(script.narration);
    // a fala que cita o arroz aponta para a oferta; cada fala cabe no motor
    const arroz = ctx.products[0].id;
    expect(script.scenes.some((s) => s.productRef === arroz)).toBe(true);
    expect(script.scenes.every((s) => estimateSpeechSecondsRaw(s.dialogue as string) <= 15)).toBe(
      true,
    );
    expect(validateScriptV2(script, { format: 'talking_art' })).toEqual([]);
  });

  it('resposta do LLM: índices inválidos/repetidos são ignorados, mais de 3 são cortados, narração vazia lança', () => {
    const ctx = ctxWith(TWELVE_OFFERS);
    const script = buildTalkingArtScript(
      {
        narration:
          'Olá, chegaram as ofertas da semana! Arroz por vinte e quatro reais e noventa centavos. Feijão por oito reais e noventa e nove centavos. Banana por cinco reais e noventa e nove centavos. Café por dezoito reais e noventa centavos. Venha ver as demais ofertas na loja!',
        citedOfferIndexes: [0, 0, 99, -1, 1, 11, 4],
      },
      ctx,
      ids,
    );
    expect(script.citedOfferIds).toEqual([
      ctx.products[0].id,
      ctx.products[1].id,
      ctx.products[11].id,
    ]);
    expect(() =>
      buildTalkingArtScript({ narration: '   ', citedOfferIndexes: [] }, ctx, ids),
    ).toThrow(/narração vazia/);
  });

  it('mock F1 válido: sem produtos (sem ofertas citadas) e com produtos; gesto só na primeira fala; cartela da loja', () => {
    const empty = buildMockScriptF1(ctxWith([]), ids);
    expect(validateScriptV2(empty, { format: 'talking_art' })).toEqual([]);
    expect(empty.citedOfferIds).toEqual([]);
    expect(empty.narration!.length).toBeGreaterThanOrEqual(MC_TALKING_ART_NARRATION_MIN_CHARS);
    expect(empty.scenes.every((s) => s.productRef === null)).toBe(true);
    const withProducts = buildMockScriptF1(ctxWith(TWELVE_OFFERS.slice(0, 2)), ids);
    expect(validateScriptV2(withProducts, { format: 'talking_art' })).toEqual([]);
    expect(withProducts.scenes[0].actionPrompt).toBe('Acena no início.');
    expect(withProducts.scenes.slice(1).every((s) => s.actionPrompt === '')).toBe(true);
    expect(withProducts.endcard).toEqual({ storeName: 'Mercado do Zé' });
    expect(isWindowWellFormed(withProducts.window)).toBe(true);
  });

  it('janela: default no canto inferior direito da área segura com o aspecto do tile; modo rosto do logo usa a caixa do logo', () => {
    const w = defaultCharacterWindow({
      width: 1080,
      height: 1920,
      tileWidth: 720,
      tileHeight: 960,
    });
    const safe = safeAreaFor(1080, 1920);
    expect(safe).toEqual({ left: 65, top: 269, right: 1015, bottom: 1248 });
    // aspecto 3:4 em pixels, dentro da área segura, encostada no canto inferior direito
    const px = { x: w.x * 1080, y: w.y * 1920, w: w.w * 1080, h: w.h * 1920 };
    expect(px.w / px.h).toBeCloseTo(0.75, 2);
    expect(px.x + px.w).toBeCloseTo(1015, 0);
    expect(px.y + px.h).toBeCloseTo(1248, 0);
    expect(px.x).toBeGreaterThanOrEqual(65);
    expect(px.y).toBeGreaterThanOrEqual(269);
    // sem tile: 3:4 default; 16:9 usa inset uniforme de 65 px
    const wide = defaultCharacterWindow({
      width: 1920,
      height: 1080,
      tileWidth: null,
      tileHeight: null,
    });
    expect((wide.w * 1920) / (wide.h * 1080)).toBeCloseTo(0.75, 2);
    expect(wide.x * 1920 + wide.w * 1920).toBeCloseTo(1855, 0);
    const logo = buildMockScriptF1(
      ctxWith([], { logoFace: true, logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 } }),
      ids,
    );
    expect(logo.logoFace).toBe(true);
    // sem as dimensões da arte, a caixa é usada como está
    expect(logo.window).toEqual({ x: 0.1, y: 0.8, w: 0.2, h: 0.1 });
    // com a arte 1080×1350 num quadro 1080×1920 a caixa desce a faixa superior (285 px)
    const logoFramed = buildMockScriptF1(
      ctxWith([], {
        logoFace: true,
        logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        art: { width: 1080, height: 1350 },
      }),
      ids,
    );
    const lw = logoFramed.window!;
    // ±2 px: frações com 4 casas e pixels pares no compose
    const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(2);
    near(lw.x * 1080, 108);
    near(lw.y * 1920, 285 + 0.8 * 1350);
    near(lw.w * 1080, 216);
    near(lw.h * 1920, 135);
    // logoFace sem caixa resolvida → modo desligado, janela default
    const noBox = buildMockScriptF1(ctxWith([], { logoFace: true, logoBox: null }), ids);
    expect(noBox.logoFace).toBe(false);
  });

  it('normalizeDirectorScenesV2 aceita talk_tile sem coagir pela fala (gesto vazio permitido; sem fala é descartada)', () => {
    const scenes = normalizeDirectorScenesV2(
      [
        {
          sceneType: 'talk_tile',
          actionPrompt: '',
          dialogue: 'Olá!',
          durationS: 5,
          productIndex: null,
        },
        {
          sceneType: 'talk_tile',
          actionPrompt: 'acena',
          dialogue: '',
          durationS: 5,
          productIndex: null,
        },
        {
          sceneType: 'action',
          actionPrompt: 'pega',
          dialogue: 'fala',
          durationS: 5,
          productIndex: null,
        },
      ],
      [],
      ids,
      'test',
    );
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toMatchObject({
      sceneType: 'talk_tile',
      actionPrompt: '',
      dialogue: 'Olá!',
      sealCue: null,
      safeArea: null,
    });
    expect(scenes[0].initialFrame).toBeUndefined();
    expect(scenes[1].sceneType).toBe('action_voiceover'); // os demais tipos continuam coagidos pela fala
  });
});

describe('validateScriptV2 — formato F1 e tipos de cena por formato (tarefa 4.1 + revisão)', () => {
  it('roteiro F1 válido passa; campos quebrados devolvem os códigos por campo', () => {
    const products = [{ id: 'p1', name: 'Arroz', price: '24,90' }];
    const valid = fixtureTalkTileScript({ products });
    expect(validateScriptV2(valid, { format: 'talking_art' })).toEqual([]);

    const broken: McScript = {
      ...valid,
      narration: '  ',
      window: { x: 0.8, y: 0.2, w: 0.5, h: 0.3 }, // x + w > 1
      logoFace: 'sim' as unknown as boolean,
      citedOfferIds: ['p1', 'p1', 'ghost', 'p2'],
    };
    const codes = validateScriptV2(broken, { format: 'talking_art' }).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'NARRATION_MISSING',
        'WINDOW_INVALID',
        'LOGO_FACE_INVALID',
        'CITED_OFFERS_TOO_MANY',
        'CITED_OFFER_DUPLICATE',
        'CITED_OFFER_UNKNOWN',
      ]),
    );
    expect(
      validateScriptV2(
        { ...valid, window: { x: 0, y: 0, w: 0, h: 0.5 } },
        { format: 'talking_art' },
      ),
    ).toEqual([expect.objectContaining({ code: 'WINDOW_INVALID' })]);
    const four = {
      ...valid,
      scenes: [...valid.scenes, { ...valid.scenes[2], idx: 3, sceneId: 'fx-talk-4' }],
    };
    expect(validateScriptV2(four, { format: 'talking_art' })).toEqual([
      expect.objectContaining({ code: 'TOO_MANY_TALK_SCENES' }),
    ]);
  });

  it('FORMAT-AWARE: scenes (default) recusa talk_tile; talking_art/offer_carousel recusam cenas geradas', () => {
    const f1 = fixtureTalkTileScript();
    const scenesFormat = validateScriptV2(f1); // sem formato = scenes (chamadores legados)
    expect(scenesFormat.filter((i) => i.code === 'SCENE_TYPE_NOT_ALLOWED_FOR_FORMAT')).toHaveLength(
      3,
    );
    expect(scenesFormat[0]).toMatchObject({
      code: 'SCENE_TYPE_NOT_ALLOWED_FOR_FORMAT',
      sceneId: 'fx-talk-1',
      message:
        'Cena 1: o tipo "fala do tile" só existe nos formatos arte que fala e ofertas em sequência.',
    });
    expect(validateScriptV2(f1, { format: 'scenes' })).toEqual(scenesFormat);

    const generated: McScript = {
      ...f1,
      scenes: [
        {
          idx: 0,
          sceneId: 'gen-1',
          sceneType: 'presenter',
          initialFrame: 'frente',
          actionPrompt: 'acena',
          dialogue: 'Oi!',
          durationS: 5,
          productRef: null,
          sealCue: null,
          safeArea: null,
          camera: null,
          environmentId: null,
        },
      ],
    };
    for (const format of ['talking_art', 'offer_carousel'] as const) {
      const issues = validateScriptV2(generated, { format });
      expect(issues).toEqual([
        expect.objectContaining({ code: 'SCENE_TYPE_NOT_ALLOWED_FOR_FORMAT', sceneId: 'gen-1' }),
      ]);
    }
  });

  it('quality: speechDurationAccepted entra no estado vazio e no leitor tolerante', () => {
    expect(MC_EMPTY_QUALITY.speechDurationAccepted).toBe(false);
    expect(resolveQuality({ speechDurationAccepted: true }).speechDurationAccepted).toBe(true);
    expect(resolveQuality({}).speechDurationAccepted).toBe(false);
  });
});
