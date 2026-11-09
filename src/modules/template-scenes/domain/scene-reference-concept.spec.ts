import { FICHA_NAVARRO, FICHA_R1, FICHA_R2 } from '../testing/reference-fichas';
import { readRaw, sanitizeConcept } from './scene-reference-concept';

const clean = (raw: unknown) => sanitizeConcept(raw);
const names = (raw: unknown): string[] => clean(raw).concept.elements.map((e) => e.element);
const reasonsOf = (raw: unknown): string[] => clean(raw).removed.map((r) => r.reason);

const flyer = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  theme: 'June festival',
  signature_elements: [],
  palette: [],
  header: { shape: 'straight', fill: 'soft' },
  ...overrides,
});

const element = (
  name: string,
  where = 'header',
  notes = 'soft',
  kind: string | null = 'decoration',
): Record<string, unknown> => ({
  element: name,
  label_pt: '',
  ...(kind ? { kind } : {}),
  where,
  notes,
});

describe('sanitizeConcept: fichas reais do estudo', () => {
  it('R1: nada sai dos elementos e a altura do cabeçalho é descartada', () => {
    const { concept, removed } = clean(FICHA_R1);
    expect(concept.elements.map((e) => e.element)).toEqual([
      'Blue checker fabric pattern',
      'Triangular paper bunting',
      'Hanging braided cords',
      'Geometric color rays',
    ]);
    expect(removed).toEqual([{ field: 'header.height_pct', text: '17', reason: 'zones_rule' }]);
    expect(concept.palette).toHaveLength(5);
  });

  it('R2: carrinho e moedas saem; raios ficam; a bandeirinha inventada fica (quem tira é a correção)', () => {
    const { concept, removed } = clean(FICHA_R2);
    expect(concept.elements.map((e) => e.element)).toEqual([
      'Deep blue geometric rays with halftone dots',
      'Small triangular paper bunting',
    ]);
    const byText = Object.fromEntries(removed.map((r) => [r.text, r.reason]));
    expect(byText['Circular shopping-cart medallion']).toBe('logo_badge');
    expect(byText['Glossy gold coin medallions']).toBe('logo_badge');
  });

  it('R1 (estrutural): o selo vem pelo campo kind, mesmo parafraseado sem nenhum termo da tabela', () => {
    const raw = flyer({
      signature_elements: [
        element('large circular gold ornament with a ring', 'top right', 'glossy', 'logo_or_badge'),
        element('striped canvas over one produce area', 'top edge', 'red', 'section_decoration'),
        element('flame shapes', 'bottom edge', 'orange', 'section_decoration'),
        element('grass strip', 'bottom edge', 'green', 'section_decoration'),
        element('sparkles', 'corners', 'tiny', 'decoration'),
      ],
    });
    expect(names(raw)).toEqual(['sparkles']);
    expect(clean(raw).removed).toEqual([
      {
        field: 'signature_elements',
        text: 'large circular gold ornament with a ring',
        reason: 'logo_badge',
      },
      {
        field: 'signature_elements',
        text: 'striped canvas over one produce area',
        reason: 'section_or_unknown_place',
      },
      { field: 'signature_elements', text: 'flame shapes', reason: 'section_or_unknown_place' },
      { field: 'signature_elements', text: 'grass strip', reason: 'section_or_unknown_place' },
    ]);
  });

  it('kind ausente ou fora do conjunto: o elemento cai (falha fechada, motivo invalid)', () => {
    const raw = flyer({
      signature_elements: [
        element('rays', 'header', 'soft', null),
        element('bunting', 'header', 'soft', 'banner'),
      ],
    });
    expect(names(raw)).toEqual([]);
    expect(reasonsOf(raw)).toEqual(['invalid', 'invalid']);
  });

  it('R2: header.shape vira o conjunto fechado e name_pt passa pela tabela de termos', () => {
    const shaped = (shape: string) => clean(flyer({ header: { shape } })).concept.header.shape;
    expect(shaped('Straight lower edge with layered rays')).toBe('straight');
    expect(shaped('Soft wave pattern')).toBe('wave');
    expect(shaped('round gold medallion edge')).toBe('');
    const { concept, removed } = clean(
      flyer({
        palette: [
          { hex: '#112233', name_pt: 'dourado do selo', role: 'header' },
          { hex: '#445566', name_pt: 'azul', role: 'header' },
        ],
      }),
    );
    expect(concept.palette.map((c) => c.namePt)).toEqual(['#112233', 'azul']);
    expect(removed).toContainEqual({
      field: 'palette.name_pt',
      text: 'dourado do selo',
      reason: 'logo_badge',
    });
  });

  it('Navarro (D-1): o medalhão do topo à direita sai com logo_badge; ficam o bokeh e a faixa de baixo', () => {
    const { concept, removed } = clean(FICHA_NAVARRO);
    expect(concept.elements.map((e) => e.element)).toEqual([
      'Warm blurred color forms and soft bokeh',
      'Narrow warm-toned horizontal accent',
    ]);
    expect(concept.elements.map((e) => e.where)).toEqual(['header', 'bottom edge']);
    expect(removed).toContainEqual({
      field: 'signature_elements',
      text: 'Large circular medallion with an abstract shopping-cart symbol',
      reason: 'logo_badge',
    });
    // O medalhão também sai da frase livre do cabeçalho (header.fill), sem derrubar o resto.
    expect(concept.header.fill).not.toMatch(/medallion/i);
    expect(concept.header.fill).toMatch(/bokeh/i);
  });
});

describe('sanitizeConcept: casos', () => {
  it('frases que puxam conteúdo viram abstração e a oração com o termo sai', () => {
    const { concept, removed } = clean(
      flyer({
        background_texture:
          'softly blurred supermarket-shelf photography, compact red tags and dark supporting text',
        palette: [
          { hex: '#E94036', role: 'price-area accent' },
          { hex: '#1739D2', role: 'header' },
        ],
      }),
    );
    expect(concept.backgroundTexture).toBe('warm blurred bokeh');
    expect(concept.palette.map((c) => c.hex)).toEqual(['#1739D2']);
    expect(removed.map((r) => r.reason)).toEqual(
      expect.arrayContaining(['retail_symbol', 'text', 'section_color']),
    );
    expect(removed.find((r) => r.reason === 'section_color')?.text).toContain('#E94036');
  });

  it('palavra parecida não derruba: faceted e zigzag ficam', () => {
    expect(
      names(
        flyer({
          signature_elements: [
            element('faceted geometric light rays'),
            element('zigzag pennant strip'),
          ],
        }),
      ),
    ).toEqual(['faceted geometric light rays', 'zigzag pennant strip']);
  });

  it('plural e acento: medalhões, selos e carrinho em português saem', () => {
    const raw = flyer({
      signature_elements: [
        element('medalhões dourados'),
        element('selo redondo'),
        element('Carrinho de compras'),
        element('bandeirinhas'),
      ],
    });
    expect(names(raw)).toEqual(['bandeirinhas']);
    expect(reasonsOf(raw)).toEqual(['logo_badge', 'logo_badge', 'retail_symbol']);
  });

  it.each([
    ['logo', 'brand'],
    ['QR code strip', 'codes'],
    ['lettering banner', 'text'],
    ['smiling person', 'people'],
    ['product photo montage', 'content'],
    ['percent sign', 'retail_symbol'],
    ['R$ 9,99 burst', 'retail_symbol'],
  ])('elemento "%s" cai com o motivo %s', (name, reason) => {
    const raw = flyer({ signature_elements: [element(name)] });
    expect(names(raw)).toEqual([]);
    expect(reasonsOf(raw)).toEqual([reason]);
  });

  it('o termo nas notas também derruba o elemento', () => {
    expect(
      names(flyer({ signature_elements: [element('ribbon', 'header', 'holds a store name')] })),
    ).toEqual([]);
  });

  it('where: normaliza e derruba o que não é cabeçalho, borda ou fundo', () => {
    const { concept, removed } = clean(
      flyer({
        signature_elements: [
          element('a', 'top right'),
          element('b', 'TOP'),
          element('c', 'bottom'),
          element('d', 'over the produce section'),
          element('e', ''),
        ],
      }),
    );
    expect(concept.elements.map((e) => e.where)).toEqual(['corners', 'top edge', 'bottom edge']);
    expect(removed.map((r) => r.reason)).toEqual([
      'section_or_unknown_place',
      'section_or_unknown_place',
    ]);
  });

  it('limites: 6 elementos, 7 cores, hex inválido sai', () => {
    const many = Array.from({ length: 9 }, (_, i) => element(`rays ${i}`));
    const colors = Array.from({ length: 9 }, (_, i) => ({ hex: `#10203${i}`, role: 'accent' }));
    const { concept, removed } = clean(
      flyer({
        signature_elements: many,
        palette: [{ hex: 'azul', role: 'x' }, ...colors],
      }),
    );
    expect(concept.elements).toHaveLength(6);
    expect(concept.palette).toHaveLength(7);
    expect(removed).toContainEqual({ field: 'palette', text: 'azul', reason: 'invalid' });
  });

  it('rótulos: label_pt vazio cai no element e name_pt vazio cai no hex', () => {
    const { concept } = clean(
      flyer({
        signature_elements: [
          { element: 'rays', label_pt: 'raios', kind: 'decoration', where: 'header', notes: '' },
        ],
        palette: [{ hex: '#1739d2', role: 'header' }],
      }),
    );
    expect(concept.elements[0].labelPt).toBe('raios');
    expect(concept.palette[0]).toMatchObject({ hex: '#1739D2', namePt: '#1739D2' });
  });

  it('entrada fora da forma não lança: campos viram vazios', () => {
    const { concept } = clean({ theme: 7, signature_elements: 'x', palette: null, header: 3 });
    expect(concept).toMatchObject({ theme: '', elements: [], palette: [], header: { shape: '' } });
    expect(clean(null).concept.elements).toEqual([]);
  });

  it('corta cada string em 240 caracteres', () => {
    expect(clean(flyer({ theme: 'a'.repeat(500) })).concept.theme).toHaveLength(240);
  });
});

describe('readRaw', () => {
  it('aceita a ficha com elementos ou paleta, mesmo sem is_retail_flyer', () => {
    expect(readRaw(FICHA_R1)).toEqual({ kind: 'ok' });
    expect(readRaw({ is_retail_flyer: true, palette: [] })).toEqual({ kind: 'ok' });
  });

  it('is_retail_flyer false vale como "não é encarte", mesmo sem o resto', () => {
    expect(readRaw({ is_retail_flyer: false })).toEqual({ kind: 'not_flyer' });
  });

  it('sem signature_elements nem palette, ou fora da forma, é inválida', () => {
    expect(readRaw({ theme: 'x' })).toEqual({ kind: 'invalid' });
    expect(readRaw('texto')).toEqual({ kind: 'invalid' });
    expect(readRaw({ signature_elements: 'x', palette: 3 })).toEqual({ kind: 'invalid' });
  });
});
