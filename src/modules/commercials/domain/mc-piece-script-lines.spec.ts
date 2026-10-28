import { buildMockScriptPiece } from './mc-director';
import {
  deriveCarouselLines,
  normalizeOfferCarouselScript,
  validateScriptV2,
} from './mc-script-v2';
import { McScript, McSealProduct } from './mc-types';

/** Roteiro curto da peça (video-fala-continua D11, P-21): papel pelo vínculo, 1 a ofertas + 2 falas. */
const offer = (id: string, name: string, price: string): McSealProduct => ({
  id,
  name,
  price,
  imageUrl: `/uploads/g/${id}.png`,
});
const OFFERS = [offer('o1', 'Picanha bovina', '59,90'), offer('o2', 'Arroz tipo 1', '24,90')];

function baseScript(offers: McSealProduct[] = OFFERS): McScript {
  let seq = 0;
  return buildMockScriptPiece(
    {
      offers,
      storeName: 'Mercado Bom Preço',
      maxChunkS: 15,
      layoutPreset: 'character_left',
      captions: false,
      window: { x: 0.58, y: 0.6, w: 0.37, h: 0.28 },
      logoFace: false,
      talkBackgroundColor: '#FFFFFF',
      closingHint: null,
    },
    () => `sc-${++seq}`,
  );
}

/** Mantém só as cenas pedidas (por índice do roteiro completo), reindexa e normaliza como o PATCH script. */
function keep(script: McScript, indexes: number[], offers: McSealProduct[] = OFFERS): McScript {
  const scenes = indexes.map((i, idx) => ({ ...script.scenes[i], idx }));
  return normalizeOfferCarouselScript({ ...script, offers, products: offers, scenes });
}

const issuesOf = (script: McScript) =>
  validateScriptV2(script, { format: 'offer_piece' }).map((i) => i.code);

describe('roteiro curto da peça — papel pelo vínculo (D11)', () => {
  const full = baseScript(); // abertura, o1, o2, fechamento

  it('o roteiro completo do diretor continua válido (4 falas)', () => {
    expect(full.scenes).toHaveLength(4);
    expect(issuesOf(full)).toEqual([]);
  });

  it('só as falas das ofertas (N falas) é aceito', () => {
    const script = keep(full, [1, 2]);
    expect(script.lines?.map((l) => l.kind)).toEqual(['offer', 'offer']);
    expect(issuesOf(script)).toEqual([]);
  });

  it('abertura sem fechamento: a fala sem oferta antes das ofertas é a abertura', () => {
    const script = keep(full, [0, 1, 2]);
    expect(script.lines?.map((l) => l.kind)).toEqual(['opening', 'offer', 'offer']);
    expect(issuesOf(script)).toEqual([]);
  });

  it('fechamento sem abertura: a fala sem oferta depois das ofertas é o fechamento', () => {
    const script = keep(full, [1, 2, 3]);
    expect(script.lines?.map((l) => l.kind)).toEqual(['offer', 'offer', 'closing']);
    expect(issuesOf(script)).toEqual([]);
  });

  it('2 falas (abertura + 1 oferta) e 1 fala (só a oferta) com 1 oferta falada', () => {
    const one = [OFFERS[0]];
    const piece = baseScript(one);
    const two = keep(piece, [0, 1], one);
    expect(two.lines?.map((l) => l.kind)).toEqual(['opening', 'offer']);
    expect(issuesOf(two)).toEqual([]);
    const single = keep(piece, [1], one);
    expect(single.lines?.map((l) => l.kind)).toEqual(['offer']);
    expect(issuesOf(single)).toEqual([]);
  });

  it('0 falas → CAROUSEL_LINES_COUNT primeiro, "pelo menos 1 fala"', () => {
    const empty = normalizeOfferCarouselScript({ ...full, scenes: [] });
    const issues = validateScriptV2(empty, { format: 'offer_piece' });
    expect(issues[0].code).toBe('CAROUSEL_LINES_COUNT');
    expect(issues[0].message).toMatch(/^O roteiro precisa de pelo menos 2 falas/);
    const one = [OFFERS[0]];
    const single = validateScriptV2(
      normalizeOfferCarouselScript({ ...baseScript(one), scenes: [] }),
      { format: 'offer_piece' },
    );
    expect(single[0].message).toMatch(/^O roteiro precisa de pelo menos 1 fala:/);
  });

  it('menos falas que ofertas → CAROUSEL_LINES_COUNT (primeiro) e o vínculo faltante', () => {
    const issues = validateScriptV2(keep(full, [1]), { format: 'offer_piece' });
    expect(issues[0]).toMatchObject({ code: 'CAROUSEL_LINES_COUNT' });
    expect(issues[0].message).toContain('pelo menos 2 falas');
    expect(issues.map((i) => i.code)).toContain('CAROUSEL_LINES_OFFER_ORDER');
  });

  it('mais que ofertas + 2 → CAROUSEL_LINES_COUNT (máximo)', () => {
    const script = keep(full, [0, 0, 1, 2, 3]);
    const scenes = script.scenes.map((s, idx) => ({ ...s, sceneId: `x${idx}`, idx }));
    const issues = validateScriptV2(normalizeOfferCarouselScript({ ...script, scenes }), {
      format: 'offer_piece',
    });
    expect(issues[0].code).toBe('CAROUSEL_LINES_COUNT');
    expect(issues[0].message).toContain('no máximo 4 falas');
  });

  it('fala sem oferta entre duas ofertas → CAROUSEL_LINE_KIND', () => {
    expect(issuesOf(keep(full, [1, 0, 2]))).toContain('CAROUSEL_LINE_KIND');
  });

  it('duas aberturas e dois fechamentos → CAROUSEL_LINE_KIND', () => {
    const doubleOpening = keep(full, [0, 3, 1, 2]);
    expect(doubleOpening.lines?.map((l) => l.kind)).toEqual([
      'opening',
      'opening',
      'offer',
      'offer',
    ]);
    expect(issuesOf(doubleOpening)).toContain('CAROUSEL_LINE_KIND');
    expect(issuesOf(keep(full, [1, 2, 0, 3]))).toContain('CAROUSEL_LINE_KIND');
  });

  it('fechamento antes de uma fala de oferta, com falas explícitas → CAROUSEL_LINE_KIND', () => {
    const script = keep(full, [1, 2]);
    const lines = script.lines!.map((l, i) => (i === 0 ? { ...l, kind: 'closing' as const } : l));
    const issues = validateScriptV2({ ...script, lines }, { format: 'offer_piece' }).map(
      (i) => i.code,
    );
    expect(issues).toContain('CAROUSEL_LINE_KIND');
  });

  it('fala de oferta sem a oferta → CAROUSEL_LINE_OFFER_MISSING', () => {
    const script = keep(full, [1, 2]);
    const lines = script.lines!.map((l, i) => (i === 0 ? { ...l, offerRef: null } : l));
    const issues = validateScriptV2({ ...script, lines }, { format: 'offer_piece' }).map(
      (i) => i.code,
    );
    expect(issues).toContain('CAROUSEL_LINE_OFFER_MISSING');
  });

  it('deriveCarouselLines: sem o formato (offer_carousel) o papel segue por posição', () => {
    expect(deriveCarouselLines(full.scenes).map((l) => l.kind)).toEqual([
      'opening',
      'offer',
      'offer',
      'closing',
    ]);
    // a 1ª cena de oferta no carrossel é "abertura" por posição, mesmo com vínculo
    const shifted = full.scenes.slice(1);
    expect(deriveCarouselLines(shifted)[0].kind).toBe('opening');
    expect(deriveCarouselLines(shifted, 'offer_piece')[0].kind).toBe('offer');
  });

  it('offer_carousel inalterado: sem abertura → CAROUSEL_LINES_COUNT estrito', () => {
    const offers = [...OFFERS, offer('o3', 'Refrigerante', '7,99')];
    const piece = baseScript(offers);
    const carousel: McScript = normalizeOfferCarouselScript({
      ...piece,
      format: 'offer_carousel',
      offers,
      products: offers,
      scenes: piece.scenes.slice(1).map((s, idx) => ({ ...s, idx })),
    });
    const issues = validateScriptV2(carousel, { format: 'offer_carousel' });
    expect(issues.find((i) => i.code === 'CAROUSEL_LINES_COUNT')?.message).toContain(
      'precisa de 5 falas',
    );
  });
});
