import { FilenameMetadataRecoveryService } from './filename-metadata-recovery.service';
import { ProductMetadata } from './product-metadata.schema';

const base = (over: Partial<ProductMetadata> = {}): ProductMetadata => ({
  title: 'Produto',
  category: { id: 1, path: ['Alimentos'] },
  quantity: null,
  packageType: null,
  pack: null,
  alternatives: [{ brand: null, subBrand: null, variant: null }],
  ean: null,
  sku: null,
  claims: [],
  promo: null,
  dominantColors: [],
  fieldConfidence: {},
  source: 'vision',
  modelVersion: 'vision-v1',
  warnings: [],
  ...over,
});

describe('FilenameMetadataRecoveryService', () => {
  const service = new FilenameMetadataRecoveryService({} as never, {} as never, {} as never);

  describe('filenameToProductName', () => {
    it('remove a extensão', () => {
      expect(service.filenameToProductName('Oliron - 5kg.jpg')).toBe('Oliron - 5kg');
    });

    it('remove sufixo de variante de foto (002)', () => {
      expect(service.filenameToProductName('Lacta - amandita 200g 002.jpg')).toBe(
        'Lacta - amandita 200g',
      );
    });

    it('remove sufixo de variante de foto (c3)', () => {
      expect(service.filenameToProductName('Pocket Ball Supreme 32g c3.jpg')).toBe(
        'Pocket Ball Supreme 32g',
      );
    });

    it('não confunde quantidade com sufixo de foto', () => {
      expect(service.filenameToProductName('Tio Joao - arborio 500g.jpg')).toBe(
        'Tio Joao - arborio 500g',
      );
    });
  });

  describe('mergeIntoMetadata', () => {
    it('preenche marca e quantidade ausentes', () => {
      const result = service.mergeIntoMetadata(
        base(),
        base({
          alternatives: [{ brand: 'Oliron', subBrand: null, variant: 'Arroz Tipo 1' }],
          quantity: { value: 5, unit: 'kg' },
        }),
      );

      expect(result).not.toBeNull();
      expect(result!.metadata.alternatives[0].brand).toBe('Oliron');
      expect(result!.metadata.quantity).toEqual({ value: 5, unit: 'kg' });
      expect(result!.recovered).toEqual(expect.arrayContaining(['brand', 'variant', 'quantity']));
    });

    it('NUNCA sobrescreve marca já extraída pela visão', () => {
      const current = base({
        alternatives: [{ brand: 'Sensação', subBrand: null, variant: null }],
      });
      const result = service.mergeIntoMetadata(
        current,
        base({ alternatives: [{ brand: 'Outra Marca', subBrand: null, variant: null }] }),
      );

      expect(result).toBeNull();
    });

    it('NUNCA sobrescreve a categoria da visão', () => {
      const current = base({ category: { id: 148, path: ['Chocolates'] } });
      const result = service.mergeIntoMetadata(
        current,
        base({
          category: { id: 999, path: ['Outros'] },
          quantity: { value: 100, unit: 'g' },
        }),
      );

      expect(result!.metadata.category).toEqual({ id: 148, path: ['Chocolates'] });
      expect(result!.recovered).not.toContain('category');
    });

    it('retorna null quando não há nada a recuperar', () => {
      const full = base({
        alternatives: [{ brand: 'ABC', subBrand: null, variant: 'Carioca' }],
        quantity: { value: 1, unit: 'kg' },
        packageType: 'pacote',
      });
      expect(service.mergeIntoMetadata(full, full)).toBeNull();
    });

    it('registra a origem da recuperação em warnings', () => {
      const result = service.mergeIntoMetadata(
        base(),
        base({ quantity: { value: 500, unit: 'g' } }),
      );
      expect(result!.metadata.warnings).toContain('filename-recovery: quantity');
    });

    it('preserva warnings anteriores', () => {
      const result = service.mergeIntoMetadata(
        base({ warnings: ['algo antigo'] }),
        base({ quantity: { value: 500, unit: 'g' } }),
      );
      expect(result!.metadata.warnings).toEqual(['algo antigo', 'filename-recovery: quantity']);
    });
  });
});
