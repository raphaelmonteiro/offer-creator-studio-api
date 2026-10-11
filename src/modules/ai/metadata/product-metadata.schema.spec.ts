import { canOverwriteEan, ProductMetadataSchema } from './product-metadata.schema';

/** Metadata no formato dos 12.815 registros de produção, sem bloco de EAN. */
const METADATA_ANTIGO = {
  title: 'Biscoito Club Social Queijo',
  category: null,
  quantity: { value: 141, unit: 'g' },
  packageType: null,
  pack: null,
  alternatives: [{ brand: 'Club Social', subBrand: null, variant: 'queijo' }],
  ean: null,
  sku: null,
  claims: [],
  promo: null,
  dominantColors: [],
  fieldConfidence: {},
  source: 'vision',
  modelVersion: 'vision-v1-2026-06',
  warnings: [],
};

describe('ProductMetadataSchema — proveniência do vínculo de planilha', () => {
  it('continua aceitando metadata antigo sem eanVerifiedBy/eanJobId', () => {
    expect(ProductMetadataSchema.safeParse(METADATA_ANTIGO).success).toBe(true);
  });

  it('aceita os campos novos de proveniência', () => {
    const r = ProductMetadataSchema.safeParse({
      ...METADATA_ANTIGO,
      ean: '7622300991333',
      eanSource: 'erp',
      eanStatus: 'resolved',
      eanVerifiedBy: 'ai-consensus',
      eanJobId: '0b5c7a3e-0000-4000-8000-000000000000',
    });
    expect(r.success).toBe(true);
  });

  it('rejeita um verificador desconhecido', () => {
    const r = ProductMetadataSchema.safeParse({ ...METADATA_ANTIGO, eanVerifiedBy: 'palpite' });
    expect(r.success).toBe(false);
  });
});

describe('ProductMetadataSchema — fonte DotCompany', () => {
  it('aceita EAN vindo da DotCompany, exato ou por âncora', () => {
    for (const eanVerifiedBy of ['exact', 'anchor'] as const) {
      const r = ProductMetadataSchema.safeParse({
        ...METADATA_ANTIGO,
        ean: '7891000100103',
        eanSource: 'dotcompany',
        eanVerifiedBy,
        eanConfidence: 1,
      });
      expect(r.success).toBe(true);
    }
  });

  it('dotcompany só perde para revisão manual', () => {
    expect(canOverwriteEan('dotcompany', 'manual')).toBe(true);
    expect(canOverwriteEan('dotcompany', 'dotcompany')).toBe(true);
    for (const menor of ['erp', 'barcode-scan', 'cosmos', 'off'] as const) {
      expect(canOverwriteEan('dotcompany', menor)).toBe(false);
      expect(canOverwriteEan(menor, 'dotcompany')).toBe(true);
    }
    expect(canOverwriteEan('manual', 'dotcompany')).toBe(false);
  });
});
