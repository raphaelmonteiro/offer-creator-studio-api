import {
  isPlausibleRetailGtin,
  isValidGtin,
  normalizeGtin,
  normalizeBrand,
  canonicalQuantity,
  parseFreeTextQuantity,
  quantityMatches,
} from './gtin.util';

describe('gtin.util', () => {
  describe('isValidGtin', () => {
    it.each([
      ['7891000100103', 'Leite Moça'],
      ['7894900011517', 'Coca-Cola BR'],
      ['7891910000197', 'Açúcar União'],
      ['7622210951342', 'Lacta'],
    ])('aceita EAN-13 real válido %s (%s)', (gtin) => {
      expect(isValidGtin(gtin)).toBe(true);
    });

    it('rejeita dígito verificador errado', () => {
      expect(isValidGtin('7891000100104')).toBe(false);
    });

    it('rejeita o lixo colaborativo da OFF', () => {
      // A base da OFF tem entradas como esta, com marca "Coca-Cola" e nome
      // "Farandole de madeleine". O checksum é o que as remove.
      expect(isValidGtin('00000022')).toBe(false);
      expect(isValidGtin('0000002123456')).toBe(false);
    });

    it('rejeita comprimento inválido', () => {
      expect(isValidGtin('123')).toBe(false);
      expect(isValidGtin('789100010010')).toBe(false);
    });

    it('rejeita não-dígitos', () => {
      expect(isValidGtin('789100010010X')).toBe(false);
    });
  });

  describe('isPlausibleRetailGtin', () => {
    it.each([['7891000100103'], ['7894900011517'], ['7622210951342']])(
      'aceita GTIN de varejo real %s',
      (gtin) => {
        expect(isPlausibleRetailGtin(gtin)).toBe(true);
      },
    );

    it('rejeita lixo da OFF com checksum válido', () => {
      // Ambos passam no checksum GS1, mas são entradas de teste da OFF.
      expect(isValidGtin('00000086')).toBe(true);
      expect(isPlausibleRetailGtin('00000086')).toBe(false);

      expect(isValidGtin('00002332')).toBe(true);
      expect(isPlausibleRetailGtin('00002332')).toBe(false);
    });

    it('rejeita código com zeros à esquerda (não é GTIN emitido pela GS1)', () => {
      expect(isPlausibleRetailGtin('0000200375991')).toBe(false);
    });

    it('rejeita checksum inválido', () => {
      expect(isPlausibleRetailGtin('7891000100104')).toBe(false);
    });
  });

  describe('normalizeGtin', () => {
    it('remove separadores', () => {
      expect(normalizeGtin('789 1000-100103')).toBe('7891000100103');
    });

    it('devolve null para código inválido', () => {
      expect(normalizeGtin('00000022')).toBeNull();
      expect(normalizeGtin(null)).toBeNull();
      expect(normalizeGtin('')).toBeNull();
    });
  });

  describe('normalizeBrand', () => {
    it('remove acento e caixa', () => {
      expect(normalizeBrand('Sensação')).toBe('sensacao');
      expect(normalizeBrand('Tio João')).toBe('tio joao');
    });

    it('normaliza pontuação para espaço', () => {
      expect(normalizeBrand('mu-mu')).toBe('mu mu');
      expect(normalizeBrand('Coca-Cola')).toBe('coca cola');
    });

    it('lida com nulo', () => {
      expect(normalizeBrand(null)).toBe('');
    });
  });

  describe('canonicalQuantity', () => {
    it('converte kg para g', () => {
      expect(canonicalQuantity({ value: 5, unit: 'kg' })).toEqual({ value: 5000, unit: 'g' });
    });

    it('converte l para ml', () => {
      expect(canonicalQuantity({ value: 1.5, unit: 'l' })).toEqual({ value: 1500, unit: 'ml' });
    });

    it('faz 5kg e 5000g convergirem (a visão não converte)', () => {
      expect(canonicalQuantity({ value: 5, unit: 'kg' })).toEqual(
        canonicalQuantity({ value: 5000, unit: 'g' }),
      );
    });

    it('rejeita valor não positivo', () => {
      expect(canonicalQuantity({ value: 0, unit: 'g' })).toBeNull();
      expect(canonicalQuantity(null)).toBeNull();
    });
  });

  describe('parseFreeTextQuantity', () => {
    it.each([
      ['590 g', { value: 590, unit: 'g' }],
      ['250g', { value: 250, unit: 'g' }],
      ['1 L', { value: 1000, unit: 'ml' }],
      ['1,5 L', { value: 1500, unit: 'ml' }],
      ['33 cl', { value: 330, unit: 'ml' }],
      ['12 un', { value: 12, unit: 'un' }],
    ])('interpreta "%s"', (raw, expected) => {
      expect(parseFreeTextQuantity(raw)).toEqual(expected);
    });

    it('soma multipack', () => {
      expect(parseFreeTextQuantity('2 x 500 ml')).toEqual({ value: 1000, unit: 'ml' });
      expect(parseFreeTextQuantity('6x350ml')).toEqual({ value: 2100, unit: 'ml' });
    });

    it('devolve null para texto sem quantidade', () => {
      expect(parseFreeTextQuantity('')).toBeNull();
      expect(parseFreeTextQuantity('caixa')).toBeNull();
      expect(parseFreeTextQuantity(null)).toBeNull();
    });
  });

  describe('quantityMatches', () => {
    it('casa unidades-base iguais', () => {
      expect(quantityMatches({ value: 1000, unit: 'g' }, { value: 1000, unit: 'g' })).toBe(true);
    });

    it('tolera 2% de arredondamento de embalagem', () => {
      expect(quantityMatches({ value: 355, unit: 'ml' }, { value: 350, unit: 'ml' })).toBe(true);
    });

    it('recusa diferença acima da tolerância', () => {
      expect(quantityMatches({ value: 500, unit: 'g' }, { value: 400, unit: 'g' })).toBe(false);
    });

    it('nunca casa unidades diferentes', () => {
      expect(quantityMatches({ value: 500, unit: 'g' }, { value: 500, unit: 'ml' })).toBe(false);
    });

    it('null nunca casa', () => {
      expect(quantityMatches(null, { value: 500, unit: 'g' })).toBe(false);
    });
  });
});
