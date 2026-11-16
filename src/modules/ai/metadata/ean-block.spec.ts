import { PRODUCT_ALIAS_MAX, ProductAlias, readProductAliases } from '../../gallery/product-alias';
import { aliasAt, aliasesAtMax } from '../../gallery/product-alias.testutil';
import { mergeEanBlock } from './ean-block';
import { ProductMetadata } from './product-metadata.schema';

const BASE: ProductMetadata = {
  title: 'Leite Condensado Moça Lata 395g',
  category: null,
  quantity: { value: 395, unit: 'g' },
  packageType: 'lata',
  pack: null,
  alternatives: [{ brand: 'Moça', subBrand: null, variant: null }],
  ean: null,
  sku: null,
  claims: [],
  promo: null,
  dominantColors: [],
  fieldConfidence: {},
  source: 'vision',
  modelVersion: 'vision-v1',
  warnings: [],
};

const DOTCOMPANY: ProductMetadata = {
  ...BASE,
  source: 'name-parse',
  ean: '7891000100103',
  eanSource: 'dotcompany',
  eanVerifiedBy: 'exact',
  eanConfidence: 1,
  eanVerifiedAt: '2026-10-10T12:00:00.000Z',
  eanStatus: 'resolved',
};

/** O que uma nova extração por visão devolve: descritivo novo, sem bloco EAN. */
const VISAO: ProductMetadata = {
  ...BASE,
  title: 'Leite Condensado Moça 395g',
  modelVersion: 'vision-v2',
};

describe('mergeEanBlock', () => {
  it('sem EAN atual, grava o que chegou', () => {
    expect(mergeEanBlock(BASE, VISAO)).toEqual(VISAO);
    expect(mergeEanBlock(null, VISAO)).toEqual(VISAO);
  });

  it('nova extração por visão atualiza o descritivo e preserva o EAN dotcompany inteiro', () => {
    const r = mergeEanBlock(DOTCOMPANY, VISAO);
    expect(r.title).toBe('Leite Condensado Moça 395g');
    expect(r.modelVersion).toBe('vision-v2');
    expect(r).toMatchObject({
      ean: '7891000100103',
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
      eanConfidence: 1,
      eanVerifiedAt: '2026-10-10T12:00:00.000Z',
      eanStatus: 'resolved',
    });
  });

  it('visão que lê outro EAN não substitui: mantém o atual e registra a divergência', () => {
    const r = mergeEanBlock(DOTCOMPANY, { ...VISAO, ean: '7891000100110' });
    expect(r.ean).toBe('7891000100103');
    expect(r.eanSource).toBe('dotcompany');
    expect(r.warnings).toContain('ean-divergente:7891000100110');
  });

  it('visão que lê o mesmo EAN não gera aviso', () => {
    const r = mergeEanBlock(DOTCOMPANY, { ...VISAO, ean: '7891000100103' });
    expect(r.warnings).toEqual([]);
    expect(r.eanSource).toBe('dotcompany');
  });

  it('fonte menor (off) não sobrescreve dotcompany', () => {
    const r = mergeEanBlock(DOTCOMPANY, {
      ...DOTCOMPANY,
      ean: '7891000999998',
      eanSource: 'off',
      eanVerifiedBy: null,
      eanConfidence: 0.8,
    });
    expect(r.ean).toBe('7891000100103');
    expect(r.eanSource).toBe('dotcompany');
    expect(r.eanConfidence).toBe(1);
    expect(r.warnings).toContain('ean-divergente:7891000999998');
  });

  it('revisão manual prevalece sobre dotcompany', () => {
    const manual = {
      ...DOTCOMPANY,
      ean: '7891000100110',
      eanSource: 'manual' as const,
      eanVerifiedBy: 'human' as const,
    };
    expect(mergeEanBlock(DOTCOMPANY, manual)).toEqual(manual);
  });

  it('dotcompany substitui EAN de fonte menor', () => {
    const off = { ...BASE, ean: '7891000999998', eanSource: 'off' as const, eanConfidence: 0.7 };
    expect(mergeEanBlock(off, DOTCOMPANY)).toEqual(DOTCOMPANY);
  });

  it('metadata legado com EAN sem fonte aceita nova leitura sem fonte', () => {
    const legado = { ...BASE, ean: '7891000999998' };
    const nova = { ...VISAO, ean: '7891000100103' };
    expect(mergeEanBlock(legado, nova)).toEqual(nova);
  });

  it('limpeza só apaga EAN da fonte indicada', () => {
    const off = {
      ...BASE,
      ean: '7891000999998',
      eanSource: 'off' as const,
      eanStatus: 'resolved' as const,
    };
    const limpo = { ...off, ean: null, eanSource: null, eanStatus: 'review' as const };
    expect(mergeEanBlock(off, limpo, { clearEanSource: 'off' })).toEqual(limpo);

    const r = mergeEanBlock(
      DOTCOMPANY,
      { ...DOTCOMPANY, ean: null, eanSource: null },
      { clearEanSource: 'off' },
    );
    expect(r.ean).toBe('7891000100103');
    expect(r.eanSource).toBe('dotcompany');
  });
});

const ABACATE: ProductAlias = {
  name: 'ABACATE',
  key: 'ABACATE',
  chosenAt: '2026-11-01T10:00:00.000Z',
};
const ABACATE_KG: ProductAlias = {
  name: 'ABACATE KG',
  key: 'ABACATE KG',
  chosenAt: '2026-11-02T10:00:00.000Z',
};
const AVOCADO: ProductAlias = {
  name: 'AVOCADO',
  key: 'AVOCADO',
  chosenAt: '2026-11-03T10:00:00.000Z',
};
const TRES_NOMES = [ABACATE, ABACATE_KG, AVOCADO];

function comNomes(metadata: ProductMetadata, aliases: unknown): ProductMetadata {
  return { ...metadata, aliases } as ProductMetadata;
}

function nomesDe(metadata: ProductMetadata): ProductAlias[] {
  return readProductAliases(metadata);
}

describe('mergeEanBlock: nomes escolhidos (aliases) em cada caminho', () => {
  it('sem EAN atual, os nomes continuam e o descritivo é o novo', () => {
    const r = mergeEanBlock(comNomes(BASE, TRES_NOMES), VISAO);
    expect(nomesDe(r)).toEqual(TRES_NOMES);
    expect(r.title).toBe('Leite Condensado Moça 395g');
    expect(r.modelVersion).toBe('vision-v2');
  });

  it('limpeza do EAN da própria fonte tira o EAN e mantém os nomes', () => {
    const off = comNomes(
      { ...BASE, ean: '7891000999998', eanSource: 'off', eanStatus: 'resolved' },
      [ABACATE, ABACATE_KG],
    );
    const limpo = { ...BASE, ean: null, eanSource: null, eanStatus: 'review' as const };
    const r = mergeEanBlock(off, limpo, { clearEanSource: 'off' });
    expect(r.ean).toBeNull();
    expect(nomesDe(r)).toEqual([ABACATE, ABACATE_KG]);
  });

  it('EAN sem fonte sobre EAN sem fonte troca o EAN e mantém os nomes', () => {
    const legado = comNomes({ ...BASE, ean: '7891000999998' }, TRES_NOMES);
    const r = mergeEanBlock(legado, { ...VISAO, ean: '7891000100103' });
    expect(r.ean).toBe('7891000100103');
    expect(nomesDe(r)).toEqual(TRES_NOMES);
  });

  it('EAN de fonte melhor substitui o fraco e o nome continua', () => {
    const off = comNomes({ ...BASE, ean: '7891000999998', eanSource: 'off', eanConfidence: 0.7 }, [
      ABACATE,
    ]);
    const r = mergeEanBlock(off, DOTCOMPANY);
    expect(r.ean).toBe('7891000100103');
    expect(r.eanSource).toBe('dotcompany');
    expect(nomesDe(r)).toEqual([ABACATE]);
  });

  it('mantendo só o bloco do EAN atual (visão sem EAN), o nome continua', () => {
    const r = mergeEanBlock(comNomes(DOTCOMPANY, [ABACATE]), VISAO);
    expect(r).toMatchObject({ ean: '7891000100103', eanSource: 'dotcompany' });
    expect(r.title).toBe('Leite Condensado Moça 395g');
    expect(nomesDe(r)).toEqual([ABACATE]);
  });

  it('EAN lido sem fonte sobre EAN com fonte mantém o atual, o aviso e o nome', () => {
    const r = mergeEanBlock(comNomes(DOTCOMPANY, [ABACATE]), { ...VISAO, ean: '7891000100110' });
    expect(r.ean).toBe('7891000100103');
    expect(r.warnings).toContain('ean-divergente:7891000100110');
    expect(nomesDe(r)).toEqual([ABACATE]);
  });

  it('o resultado não altera o metadata atual nem o que chegou', () => {
    const atual = comNomes(DOTCOMPANY, [ABACATE]);
    const chegou = comNomes(VISAO, [ABACATE_KG]);
    mergeEanBlock(atual, chegou);
    expect(nomesDe(atual)).toEqual([ABACATE]);
    expect(nomesDe(chegou)).toEqual([ABACATE_KG]);
  });
});

describe('mergeEanBlock: a precedência do EAN não muda com nomes', () => {
  it('fonte menor não sobrescreve a maior, vira aviso e o nome continua', () => {
    const off = { ...DOTCOMPANY, ean: '7891000999998', eanSource: 'off' as const };
    const r = mergeEanBlock(comNomes(DOTCOMPANY, [ABACATE]), off);
    expect(r).toMatchObject({ ean: '7891000100103', eanSource: 'dotcompany', eanConfidence: 1 });
    expect(r.warnings).toContain('ean-divergente:7891000999998');
    expect(nomesDe(r)).toEqual([ABACATE]);
  });

  it('revisão manual prevalece e o nome continua', () => {
    const manual = { ...DOTCOMPANY, ean: '7891000100110', eanSource: 'manual' as const };
    const r = mergeEanBlock(comNomes(DOTCOMPANY, [ABACATE]), manual);
    expect(r).toMatchObject({ ean: '7891000100110', eanSource: 'manual' });
    expect(nomesDe(r)).toEqual([ABACATE]);
  });

  it('limpeza de outra fonte não apaga o EAN, não cria aviso e o nome continua', () => {
    const limpo = { ...DOTCOMPANY, ean: null, eanSource: null };
    const r = mergeEanBlock(comNomes(DOTCOMPANY, [ABACATE]), limpo, { clearEanSource: 'off' });
    expect(r.ean).toBe('7891000100103');
    expect(r.warnings).toEqual([]);
    expect(nomesDe(r)).toEqual([ABACATE]);
  });
});

describe('mergeEanBlock: foto sem nomes', () => {
  it.each([
    ['sem EAN, sem a chave', BASE, VISAO],
    ['com EAN, sem a chave', DOTCOMPANY, VISAO],
    ['sem EAN, `aliases: []` no atual', comNomes(BASE, []), VISAO],
    ['com EAN, `aliases: []` no atual', comNomes(DOTCOMPANY, []), VISAO],
    ['`aliases: []` nos dados novos', BASE, comNomes(VISAO, [])],
    ['`aliases: []` nos dois, com EAN', comNomes(DOTCOMPANY, []), comNomes(VISAO, [])],
    ['`aliases` que não é lista', comNomes(DOTCOMPANY, 'ABACATE'), VISAO],
  ])('%s: nenhuma chave aliases', (_caso, atual, novo) => {
    expect(mergeEanBlock(atual, novo)).not.toHaveProperty('aliases');
  });

  it('o resultado de sempre continua o mesmo: sem a chave, igual ao de hoje', () => {
    expect(mergeEanBlock(BASE, VISAO)).toStrictEqual(VISAO);
    expect(mergeEanBlock(null, VISAO)).toStrictEqual(VISAO);
  });
});

describe('mergeEanBlock: nomes que chegam junto com os dados novos', () => {
  it('cópia velha não apaga o nome gravado depois da leitura dela', () => {
    const arroz1 = aliasAt('PRODUTO 1', '2026-11-05T10:00:00.000Z');
    const arroz5 = aliasAt('PRODUTO 5', '2026-11-06T10:00:00.000Z');
    const atual = comNomes(BASE, [arroz1, arroz5]);
    const copiaVelha = comNomes(VISAO, [arroz1]);
    expect(nomesDe(mergeEanBlock(atual, copiaVelha))).toEqual([arroz1, arroz5]);
    const comEan = mergeEanBlock(comNomes(DOTCOMPANY, [arroz1, arroz5]), copiaVelha);
    expect(nomesDe(comEan)).toEqual([arroz1, arroz5]);
  });

  it('mesma chave com datas diferentes fica uma vez, com a data mais recente', () => {
    const nova = { ...aliasAt('PRODUTO 1', '2026-11-10T00:00:00.000Z'), name: 'Produto 1 (atual)' };
    const velha = {
      ...aliasAt('PRODUTO 1', '2026-11-01T00:00:00.000Z'),
      name: 'Produto 1 (velho)',
    };
    expect(nomesDe(mergeEanBlock(comNomes(BASE, [nova]), comNomes(VISAO, [velha])))).toEqual([
      nova,
    ]);
    expect(nomesDe(mergeEanBlock(comNomes(BASE, [velha]), comNomes(VISAO, [nova])))).toEqual([
      nova,
    ]);
  });

  it('mesma chave e mesma data: vale a entrada do metadata atual', () => {
    const noAtual = { ...aliasAt('PRODUTO 1', '2026-11-10T00:00:00.000Z'), name: 'do atual' };
    const nosNovos = { ...aliasAt('PRODUTO 1', '2026-11-10T00:00:00.000Z'), name: 'dos novos' };
    const r = mergeEanBlock(comNomes(BASE, [noAtual]), comNomes(VISAO, [nosNovos]));
    expect(nomesDe(r)).toEqual([noAtual]);
  });

  it('o atual vazio e os dados novos com nomes levam os nomes dos dados novos', () => {
    expect(nomesDe(mergeEanBlock(BASE, comNomes(VISAO, [ABACATE])))).toEqual([ABACATE]);
    expect(nomesDe(mergeEanBlock(DOTCOMPANY, comNomes(VISAO, [ABACATE])))).toEqual([ABACATE]);
  });

  it('regravar de novo dá o mesmo resultado e nunca duplica a chave', () => {
    const uma = mergeEanBlock(comNomes(DOTCOMPANY, TRES_NOMES), comNomes(VISAO, [AVOCADO]));
    const duas = mergeEanBlock(uma, comNomes(VISAO, [AVOCADO]));
    expect(nomesDe(duas)).toEqual(TRES_NOMES);
    expect(duas).toStrictEqual(uma);
  });

  it('a união acima do teto fica em 50 e o mais antigo sai', () => {
    const cinquenta = aliasesAtMax('PRODUTO');
    const maisAntigoDeTodos = aliasAt('PRODUTO 900', '2026-10-01T00:00:00.000Z');
    const r = mergeEanBlock(
      comNomes(BASE, cinquenta),
      comNomes(VISAO, [maisAntigoDeTodos, ...cinquenta]),
    );
    expect(nomesDe(r)).toEqual(cinquenta);

    const maisNovo = aliasAt('PRODUTO 901', '2026-12-01T00:00:00.000Z');
    const comNovo = nomesDe(mergeEanBlock(comNomes(BASE, cinquenta), comNomes(VISAO, [maisNovo])));
    expect(comNovo).toHaveLength(PRODUCT_ALIAS_MAX);
    expect(comNovo.map((a) => a.key)).not.toContain('PRODUTO 0');
    expect(comNovo[PRODUCT_ALIAS_MAX - 1]).toEqual(maisNovo);
  });

  it('entrada sem key ou sem name em texto não é levada adiante', () => {
    const lixo = [null, 'x', { key: 1, name: 'A' }, { key: 'B' }, { name: 'C' }, ABACATE];
    const r = mergeEanBlock(comNomes(DOTCOMPANY, lixo), VISAO);
    expect((r as Record<string, unknown>).aliases).toEqual([ABACATE]);
    const soLixo = mergeEanBlock(comNomes(DOTCOMPANY, [null, { key: 1 }]), VISAO);
    expect(soLixo).not.toHaveProperty('aliases');
  });
});
