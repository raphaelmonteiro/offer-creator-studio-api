import {
  addProductAlias,
  PRODUCT_ALIAS_MAX,
  productAliasKey,
  readProductAliases,
} from './product-alias';

describe('productAliasKey', () => {
  it('ignora caixa, acento, pontuação e espaços repetidos, mantendo a quantidade', () => {
    expect(productAliasKey(' Ling  Toscana Seara Kg ')).toBe('LING TOSCANA SEARA KG');
    expect(productAliasKey('AÇÚCAR REF. GUARANI 1KG')).toBe('ACUCAR REF GUARANI 1KG');
    expect(productAliasKey('LEITE EM PÓ NINHO  +380g')).toBe('LEITE EM PO NINHO 380G');
  });

  it('vazio ou só pontuação vira chave vazia', () => {
    expect(productAliasKey('')).toBe('');
    expect(productAliasKey(' - ')).toBe('');
    expect(productAliasKey(null)).toBe('');
  });
});

describe('addProductAlias', () => {
  const NOW = '2026-10-21T12:00:00.000Z';

  it('imagem sem metadata ganha o primeiro nome', () => {
    const r = addProductAlias(null, 'Ling Toscana Seara Kg', NOW);
    expect(r).toMatchObject({ key: 'LING TOSCANA SEARA KG', added: true });
    expect(r?.metadata.aliases).toEqual([
      { name: 'Ling Toscana Seara Kg', key: 'LING TOSCANA SEARA KG', chosenAt: NOW },
    ]);
  });

  it('preserva o resto do metadata e acumula nomes diferentes', () => {
    const meta = { title: 'Linguiça', ean: '7891000100103', aliases: [] };
    const a = addProductAlias(meta, 'LING TOSCANA SEARA KG', '2026-01-01T00:00:00.000Z')!;
    const b = addProductAlias(a.metadata, 'LINGUIÇA TOSCANA SEARA 1KG', NOW)!;
    expect(b.metadata).toMatchObject({ title: 'Linguiça', ean: '7891000100103' });
    expect(readProductAliases(b.metadata).map((x) => x.key)).toEqual([
      'LING TOSCANA SEARA KG',
      'LINGUICA TOSCANA SEARA 1KG',
    ]);
  });

  it('mesmo nome de novo só renova a data', () => {
    const a = addProductAlias(null, 'ARROZ SOLITO 1KG', '2026-01-01T00:00:00.000Z')!;
    const b = addProductAlias(a.metadata, 'arroz solito 1kg', NOW)!;
    expect(b.added).toBe(false);
    expect(readProductAliases(b.metadata)).toEqual([
      { name: 'arroz solito 1kg', key: 'ARROZ SOLITO 1KG', chosenAt: NOW },
    ]);
  });

  it('passando do teto, o mais antigo sai', () => {
    let meta: Record<string, unknown> | null = null;
    for (let i = 0; i < PRODUCT_ALIAS_MAX + 2; i += 1) {
      meta = addProductAlias(
        meta,
        `PRODUTO ${i}`,
        `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      )!.metadata;
    }
    const keys = readProductAliases(meta).map((a) => a.key);
    expect(keys).toHaveLength(PRODUCT_ALIAS_MAX);
    expect(keys[0]).toBe('PRODUTO 2');
    expect(keys[keys.length - 1]).toBe(`PRODUTO ${PRODUCT_ALIAS_MAX + 1}`);
  });

  it('nome vazio não grava nada', () => {
    expect(addProductAlias({ title: 'x' }, '  ')).toBeNull();
  });

  it('metadata com aliases malformados ignora o lixo', () => {
    const r = addProductAlias({ aliases: [null, 'x', { key: 1 }] }, 'CAFE 500G', NOW)!;
    expect(readProductAliases(r.metadata)).toHaveLength(1);
  });
});
