import {
  CAROUSEL_OFFERS,
  carouselContext,
  fixtureCarouselScript,
  lineIdFactory,
} from './__fixtures__/mc-offer-carousel.fixtures';
import {
  buildDirectorJsonSchemaF2,
  buildDirectorSystemPromptF2,
  buildOfferCarouselScript,
  buildOfferLineText,
  buildProductsSnapshot,
  estimateCarouselSpeechS,
  lineCitesPrice,
  rewriteSpokenOfferLines,
  samePrice,
  spellOutPrices,
} from './mc-director';
import {
  deriveCarouselLines,
  normalizeOfferCarouselScript,
  normalizeScriptV2,
  validateScriptV2,
} from './mc-script-v2';
import { MC_OFFER_CAROUSEL_MAX_SPEECH_S, McScript } from './mc-types';

/** Tarefa 6.6 — roteiro e diretor do F2 "ofertas em sequência". */
describe('diretor F2 — ofertas em sequência (tarefa 6.6)', () => {
  const dialogues = (script: McScript) => script.scenes.map((s) => s.dialogue as string);

  it('4 ofertas → 6 falas (abertura, 4 ofertas vinculadas na ordem, fechamento), todas talk_tile', () => {
    const script = fixtureCarouselScript(4);
    expect(script).toMatchObject({
      schemaVersion: 2,
      format: 'offer_carousel',
      layoutPreset: 'character_left',
      captions: true,
      seal: null,
      endcard: { storeName: 'Mercadão' },
    });
    expect(script.scenes).toHaveLength(6);
    expect(script.scenes.every((s) => s.sceneType === 'talk_tile')).toBe(true);
    expect(script.lines?.map((l) => l.kind)).toEqual([
      'opening',
      'offer',
      'offer',
      'offer',
      'offer',
      'closing',
    ]);
    const offerIds = CAROUSEL_OFFERS.slice(0, 4).map((o) => o.id);
    expect(script.lines?.map((l) => l.offerRef)).toEqual([null, ...offerIds, null]);
    // cena ↔ fala pela identidade; productRef = offerRef
    script.lines?.forEach((line, i) => {
      expect(line.sceneId).toBe(script.scenes[i].sceneId);
      expect(script.scenes[i].productRef ?? null).toBe(line.offerRef);
    });
    // offers congeladas com TODOS os campos; products é o espelho
    expect(script.offers?.[0]).toMatchObject({
      id: 'of-arroz',
      catalogId: CAROUSEL_OFFERS[0].catalogId,
      originalPrice: '29,90',
      badge: 'OFERTA',
      imageUrl: '/uploads/products/arroz.png',
    });
    expect(script.products).toEqual(script.offers);
    expect(validateScriptV2(script, { format: 'offer_carousel' })).toEqual([]);
  });

  it('cada fala de oferta cita o nome e o preço POR EXTENSO (sem dígitos) e a soma estimada cabe em 30 s', () => {
    const script = fixtureCarouselScript(4);
    const offerLines = script.scenes.slice(1, -1);
    offerLines.forEach((scene, i) => {
      const offer = CAROUSEL_OFFERS[i];
      expect(scene.dialogue).not.toMatch(/R\$|\d+,\d{2}/);
      expect(lineCitesPrice(scene.dialogue as string, offer.price)).toBe(true);
    });
    expect(script.scenes[1].dialogue).toBe(
      'Arroz Branco Tipo 1 por vinte e quatro reais e noventa centavos!',
    );
    // gramatura solta sai do nome falado; a unidade de venda "un" vira "a unidade"
    expect(script.scenes[3].dialogue).toBe(
      'Óleo de Soja por sete reais e noventa e nove centavos a unidade!',
    );
    expect(script.scenes[4].dialogue).toBe(
      'Leite Integral por quatro reais e setenta e nove centavos!',
    );
    expect(estimateCarouselSpeechS(dialogues(script))).toBeLessThanOrEqual(
      MC_OFFER_CAROUSEL_MAX_SPEECH_S,
    );
  });

  it('6 ofertas → 8 falas vinculadas; o orçamento estimado de 30 s é respeitado (encurta em degraus, sem cortar palavras)', () => {
    const script = fixtureCarouselScript(6);
    expect(script.scenes).toHaveLength(8);
    expect(script.lines?.filter((l) => l.kind === 'offer').map((l) => l.offerRef)).toEqual(
      CAROUSEL_OFFERS.map((o) => o.id),
    );
    expect(estimateCarouselSpeechS(dialogues(script))).toBeLessThanOrEqual(30);
    for (const [i, scene] of script.scenes.slice(1, -1).entries()) {
      expect(lineCitesPrice(scene.dialogue as string, CAROUSEL_OFFERS[i].price)).toBe(true);
    }
    expect(validateScriptV2(script, { format: 'offer_carousel' })).toEqual([]);
  });

  it('limites do formato: 2 ou 7 ofertas não viram roteiro; json_schema exige exatamente uma fala por oferta', () => {
    expect(() => fixtureCarouselScript(2)).toThrow(/3 a 6 ofertas/);
    const seven = carouselContext(6, {
      offers: [...CAROUSEL_OFFERS, { ...CAROUSEL_OFFERS[0], id: 'of-extra' }],
    });
    expect(() => buildOfferCarouselScript({}, seven, lineIdFactory())).toThrow(/recebidas: 7/);
    const schema = buildDirectorJsonSchemaF2(4) as {
      strict: boolean;
      schema: {
        properties: { offerLines: { minItems: number; maxItems: number } };
        required: string[];
      };
    };
    expect(schema.strict).toBe(true);
    expect(schema.schema.properties.offerLines).toMatchObject({ minItems: 4, maxItems: 4 });
    expect(schema.schema.required).toEqual(['opening', 'offerLines', 'closing']);
    // o schema nunca pede menos de 3 nem mais de 6
    expect(
      (
        buildDirectorJsonSchemaF2(9) as {
          schema: { properties: { offerLines: { maxItems: number } } };
        }
      ).schema.properties.offerLines.maxItems,
    ).toBe(6);
  });

  it('system prompt: ofertas na ordem com o preço por extenso a falar, teto de 30 s e loja', () => {
    const prompt = buildDirectorSystemPromptF2({
      offers: CAROUSEL_OFFERS.slice(0, 3),
      storeName: 'Mercadão',
      maxChunkS: 15,
    });
    expect(prompt).toContain('[0] Arroz Branco Tipo 1 5 kg — R$ 24,90');
    expect(prompt).toContain('(fale: "vinte e quatro reais e noventa centavos")');
    expect(prompt).toContain('caber em 30 segundos');
    expect(prompt).toContain('"Mercadão"');
  });

  it('resposta do LLM: fala sem preço ou sem nome vira a fala determinística; "R$ 15,49" é escrito por extenso; ordem pelo offerIndex', () => {
    const ctx = carouselContext(3);
    const script = buildOfferCarouselScript(
      {
        opening: 'Bom dia, freguesia!',
        offerLines: [
          { offerIndex: 2, text: 'Óleo de soja com preço de arrasar!' }, // sem preço
          { offerIndex: 0, text: 'Arroz Branco Tipo 1 por R$ 24,90, aproveite!' },
          { offerIndex: 1, text: 'Leve por quinze reais e quarenta e nove centavos!' }, // sem o nome
        ],
        closing: 'Te espero lá!',
      },
      ctx,
      lineIdFactory(),
    );
    expect(dialogues(script)).toEqual([
      'Bom dia, freguesia!',
      'Arroz Branco Tipo 1 por vinte e quatro reais e noventa centavos, aproveite!',
      buildOfferLineText(CAROUSEL_OFFERS[1]),
      buildOfferLineText(CAROUSEL_OFFERS[2]),
      'Te espero lá!',
    ]);
    expect(spellOutPrices('Leve por R$ 1.299,90 hoje')).toBe(
      'Leve por mil duzentos e noventa e nove reais e noventa centavos hoje',
    );
  });

  it('snapshot de produtos preserva preço anterior e badge (o F2 os mostra no card)', () => {
    const [arroz] = buildProductsSnapshot(CAROUSEL_OFFERS.slice(0, 1), () => 'x', 6);
    expect(arroz).toMatchObject({
      originalPrice: '29,90',
      badge: 'OFERTA',
      catalogId: arroz.catalogId,
    });
  });
});

describe('roteiro F2 — normalização e validação format-aware (tarefa 6.6)', () => {
  it('reordenar as cenas reordena as ofertas e as falas; products continua espelho', () => {
    const script = fixtureCarouselScript(4);
    const [opening, a, b, c, d, closing] = script.scenes;
    const reordered = normalizeOfferCarouselScript({
      ...script,
      scenes: [opening, c, a, b, d, closing].map((s, idx) => ({ ...s, idx })),
    });
    expect(reordered.offers?.map((o) => o.id)).toEqual([
      'of-oleo',
      'of-arroz',
      'of-cafe',
      'of-leite',
    ]);
    expect(reordered.products?.map((o) => o.id)).toEqual(reordered.offers?.map((o) => o.id));
    expect(reordered.lines?.map((l) => l.offerRef)).toEqual([
      null,
      'of-oleo',
      'of-arroz',
      'of-cafe',
      'of-leite',
      null,
    ]);
    expect(validateScriptV2(reordered, { format: 'offer_carousel' })).toEqual([]);
    // normalizeScriptV2 (o PATCH script) aplica a mesma normalização
    expect(normalizeScriptV2(reordered, () => 'id').lines).toEqual(reordered.lines);
  });

  it('2 ofertas, oferta sem foto, cena gerada, abertura com oferta e falas fora de ordem são apontadas', () => {
    const script = fixtureCarouselScript(3);
    const codes = (s: McScript) =>
      validateScriptV2(s, { format: 'offer_carousel' }).map((i) => i.code);

    const twoOffers = normalizeOfferCarouselScript({
      ...script,
      offers: script.offers?.slice(0, 2),
      products: script.products?.slice(0, 2),
      scenes: [script.scenes[0], script.scenes[1], script.scenes[2], script.scenes[4]].map(
        (s, idx) => ({ ...s, idx }),
      ),
    });
    expect(codes(twoOffers)).toEqual(expect.arrayContaining(['OFFERS_TOO_FEW']));

    const noPhoto = normalizeOfferCarouselScript({
      ...script,
      offers: script.offers?.map((o, i) => (i === 1 ? { ...o, imageUrl: null } : o)),
    });
    expect(validateScriptV2(noPhoto, { format: 'offer_carousel' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OFFER_IMAGE_REQUIRED', element: 'offer' }),
      ]),
    );

    const generated: McScript = {
      ...script,
      scenes: script.scenes.map((s, i) =>
        i === 2
          ? { ...s, sceneType: 'presenter', initialFrame: 'frente', actionPrompt: 'acena' }
          : s,
      ),
    };
    expect(codes(generated)).toContain('SCENE_TYPE_NOT_ALLOWED_FOR_FORMAT');

    const openingWithOffer: McScript = {
      ...script,
      scenes: script.scenes.map((s, i) => (i === 0 ? { ...s, productRef: 'of-arroz' } : s)),
    };
    expect(
      codes({ ...openingWithOffer, lines: deriveCarouselLines(openingWithOffer.scenes) }),
    ).toEqual(expect.arrayContaining(['CAROUSEL_LINE_OFFER_MISMATCH']));

    const swappedOffers: McScript = { ...script, offers: [...(script.offers ?? [])].reverse() };
    expect(codes(swappedOffers)).toEqual(
      expect.arrayContaining(['OFFERS_PRODUCTS_MISMATCH', 'CAROUSEL_LINES_OFFER_ORDER']),
    );
    expect(codes({ ...script, layoutPreset: 'diagonal' as never })).toContain(
      'LAYOUT_PRESET_INVALID',
    );
  });
});

describe('correção por tipo de mudança — fala reescrita (tarefa 6.8)', () => {
  it('preço atual mudou e a fala não → a fala da oferta é reescrita (proposta); as outras ficam', () => {
    const before = fixtureCarouselScript(4);
    const after: McScript = {
      ...before,
      offers: before.offers?.map((o) => (o.id === 'of-cafe' ? { ...o, price: '13,99' } : o)),
      products: before.products?.map((o) => (o.id === 'of-cafe' ? { ...o, price: '13,99' } : o)),
    };
    const { script, rewritten } = rewriteSpokenOfferLines(before, after);
    expect(rewritten).toEqual([
      {
        sceneId: before.scenes[2].sceneId,
        offerId: 'of-cafe',
        previousDialogue: before.scenes[2].dialogue,
        proposedDialogue: 'Café Torrado e Moído por treze reais e noventa e nove centavos!',
      },
    ]);
    expect(script.scenes.map((s) => s.dialogue)).toEqual(
      before.scenes.map((s, i) => (i === 2 ? rewritten[0].proposedDialogue : s.dialogue)),
    );
  });

  it('fala editada junto pelo usuário é respeitada; foto/badge/preço anterior não reescrevem; "24,9" = "24,90"', () => {
    const before = fixtureCarouselScript(3);
    const editedLine: McScript = {
      ...before,
      offers: before.offers?.map((o) =>
        o.id === 'of-arroz' ? { ...o, name: 'Arroz Parboilizado 5 kg' } : o,
      ),
      scenes: before.scenes.map((s, i) =>
        i === 1 ? { ...s, dialogue: 'Arroz parboilizado baratinho!' } : s,
      ),
    };
    expect(rewriteSpokenOfferLines(before, editedLine).rewritten).toEqual([]);
    const visual: McScript = {
      ...before,
      offers: before.offers?.map((o) => ({
        ...o,
        imageUrl: '/uploads/x.png',
        badge: null,
        originalPrice: null,
      })),
    };
    expect(rewriteSpokenOfferLines(before, visual).rewritten).toEqual([]);
    expect(samePrice('24,9', 'R$ 24,90')).toBe(true);
    const sameValue: McScript = {
      ...before,
      offers: before.offers?.map((o) => (o.id === 'of-arroz' ? { ...o, price: '24,9' } : o)),
    };
    expect(rewriteSpokenOfferLines(before, sameValue).rewritten).toEqual([]);
  });
});
