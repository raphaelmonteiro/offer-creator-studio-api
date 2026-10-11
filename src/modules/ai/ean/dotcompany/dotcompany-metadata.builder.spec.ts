import { ProductMetadata, ProductMetadataSchema } from '../../metadata/product-metadata.schema';
import {
  DotcompanyMetadataBuilder,
  WARNING_NAME_NOT_VERIFIED,
} from './dotcompany-metadata.builder';
import type { DotcompanyProduct } from './dotcompany.types';

/** Resposta real da DotCompany para 7891000100103 (consulta pública de 10/10/2026). */
const MOCA: DotcompanyProduct = {
  gtin: '7891000100103',
  nome: 'LEITE CONDENSADO MOÇA LATA 395G',
  descricao: 'LEITE CONDENSADO MOÇA LATA 395G',
  marca: 'NESTLE',
  categoria: null,
  unidade: 'UN',
  embalagem: '',
  peso_bruto: 435,
  peso_liquido: null,
  imagem_url: 'https://app.dotcompany.com.br/publico/catalogo/img/7891000100103.png?exp=1792627200',
  fonte: 'catalogo_dotcompany',
  nome_verificado: true,
};

const PARSED: ProductMetadata = {
  title: 'Leite Condensado Moça Lata 395g',
  category: { id: 42, path: ['Mercearia', 'Leites e derivados', 'Leite condensado'] },
  quantity: { value: 395, unit: 'g' },
  packageType: 'lata',
  pack: null,
  alternatives: [{ brand: 'Moça', subBrand: null, variant: 'tradicional' }],
  ean: null,
  sku: null,
  claims: [],
  promo: null,
  dominantColors: [],
  fieldConfidence: { category: 0.9, quantity: 0.95 },
  source: 'name-parse',
  modelVersion: 'name-parse-v1-2026-06',
  warnings: [],
};

const AGORA = new Date('2026-10-10T12:00:00Z');

describe('DotcompanyMetadataBuilder', () => {
  it('sobrepõe título, marca e EAN exato ao que o parser entendeu', async () => {
    const parser = { parseNames: jest.fn().mockResolvedValue([PARSED]) };
    const [m] = await new DotcompanyMetadataBuilder(parser as never).build(
      [{ ean: '7891000100103', product: MOCA }],
      AGORA,
    );

    expect(parser.parseNames).toHaveBeenCalledWith([
      { name: 'LEITE CONDENSADO MOÇA LATA 395G NESTLE', categoryHint: null },
    ]);
    expect(m).toMatchObject({
      title: 'LEITE CONDENSADO MOÇA LATA 395G',
      category: PARSED.category,
      quantity: { value: 395, unit: 'g' },
      packageType: 'lata',
      alternatives: [{ brand: 'NESTLE', subBrand: null, variant: 'tradicional' }],
      ean: '7891000100103',
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
      eanConfidence: 1,
      eanVerifiedAt: AGORA.toISOString(),
      eanStatus: 'resolved',
      source: 'name-parse',
      modelVersion: 'dotcompany-v1+name-parse-v1-2026-06',
      warnings: [],
    });
    expect(ProductMetadataSchema.safeParse(m).success).toBe(true);
  });

  it('nome não verificado vira aviso, mas o EAN continua exato', async () => {
    const parser = { parseNames: jest.fn().mockResolvedValue([PARSED]) };
    const [m] = await new DotcompanyMetadataBuilder(parser as never).build(
      [{ ean: '7891000100103', product: { ...MOCA, nome_verificado: false } }],
      AGORA,
    );
    expect(m.warnings).toContain(WARNING_NAME_NOT_VERIFIED);
    expect(m.eanVerifiedBy).toBe('exact');
  });

  it('parser falhou: metadata mínimo determinístico, válido no schema', async () => {
    const parser = { parseNames: jest.fn().mockRejectedValue(new Error('sem OpenAI')) };
    const [m] = await new DotcompanyMetadataBuilder(parser as never).build(
      [{ ean: '7891000100103', product: MOCA }],
      AGORA,
    );
    expect(m).toMatchObject({
      title: 'LEITE CONDENSADO MOÇA LATA 395G',
      category: null,
      quantity: { value: 395, unit: 'g' },
      alternatives: [{ brand: 'NESTLE' }],
      ean: '7891000100103',
      modelVersion: 'dotcompany-v1',
    });
    expect(ProductMetadataSchema.safeParse(m).success).toBe(true);
  });

  it('sem quantidade no nome usa o peso líquido do catálogo', async () => {
    const parser = { parseNames: jest.fn().mockResolvedValue([null]) };
    const [m] = await new DotcompanyMetadataBuilder(parser as never).build(
      [
        {
          ean: '7891000100103',
          product: { ...MOCA, nome: 'ESPONJA PARA BANHO PÓRUS', marca: null, peso_liquido: 30 },
        },
      ],
      AGORA,
    );
    expect(m.quantity).toEqual({ value: 30, unit: 'g' });
    expect(m.alternatives[0].brand).toBeNull();
  });
});
