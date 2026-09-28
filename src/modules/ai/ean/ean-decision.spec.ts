import { decidir, leiturasEquivalentes, rotuloCompativel } from './ean-decision';
import type { EanReferenceRecord, JudgmentRecord } from './ean-match.types';

const REF: EanReferenceRecord = {
  ean: '7891910000197',
  source: 'off',
  name: 'Açúcar Cristal União 1kg',
  brand: 'União',
  quantity: '1 kg',
  imageUrl: null,
};
const DESC = 'ACUCAR CRISTALCUCAR UNIÃO 1KG';
const LEITURA_OK = { imageId: 'cristal', brand: 'União', variant: 'Cristal', quantity: '1kg' };

function j(judge: 'A' | 'B', over: Partial<JudgmentRecord> = {}): JudgmentRecord {
  return {
    judge,
    model: 'gpt-4o',
    decision: 'match',
    imageIds: ['cristal'],
    labelReadout: [LEITURA_OK],
    reason: 'rótulo',
    costUsd: 0.01,
    ...over,
  };
}

const base = { reference: REF, descricao: DESC, calibracaoLiberada: true };

describe('decidir — regra de auto-aceite', () => {
  it('consenso + referência + rótulo coerente + calibração → auto-aceito', () => {
    const d = decidir({ ...base, judgments: [j('A'), j('B')] });
    expect(d.status).toBe('auto-accepted');
    expect(d.aiDecision).toMatchObject({ consensus: true, autoAcceptEligible: true, failed: [] });
  });

  it('juízes divergentes → revisão', () => {
    const d = decidir({ ...base, judgments: [j('A'), j('B', { imageIds: ['demerara'] })] });
    expect(d).toMatchObject({ status: 'review', reviewReason: 'judges-disagree' });
  });

  it('mesmas imagens em ordem diferente contam como consenso', () => {
    const multi = {
      decision: 'same-sku-multiple' as const,
      labelReadout: [LEITURA_OK, { ...LEITURA_OK, imageId: 'cristal2' }],
    };
    const d = decidir({
      ...base,
      judgments: [
        j('A', { ...multi, imageIds: ['cristal', 'cristal2'] }),
        j('B', { ...multi, imageIds: ['cristal2', 'cristal'] }),
      ],
    });
    expect(d.status).toBe('auto-accepted');
  });

  it('sem referência → revisão, mesmo com consenso', () => {
    const d = decidir({
      ...base,
      reference: { ...REF, source: 'none', name: null },
      judgments: [j('A'), j('B')],
    });
    expect(d).toMatchObject({ status: 'review', reviewReason: 'no-reference' });
  });

  it('quantidade lida diverge da referência → revisão', () => {
    const errado = { ...LEITURA_OK, quantity: '5kg' };
    const d = decidir({ ...base, judgments: [j('A', { labelReadout: [errado] }), j('B')] });
    expect(d).toMatchObject({ status: 'review', reviewReason: 'label-mismatch' });
  });

  it('calibração desligada → revisão, mas marcado como elegível', () => {
    const d = decidir({ ...base, calibracaoLiberada: false, judgments: [j('A'), j('B')] });
    expect(d).toMatchObject({ status: 'review', reviewReason: 'calibration-off' });
    expect(d.aiDecision.autoAcceptEligible).toBe(true);
  });

  it('juiz com saída inválida → revisão', () => {
    const d = decidir({ ...base, judgments: [j('A'), j('B', { error: 'não é JSON' })] });
    expect(d).toMatchObject({ status: 'review', reviewReason: 'invalid-judgment' });
  });

  it('"nenhuma" unânime com referência → sem imagem', () => {
    const none = { decision: 'none' as const, imageIds: [], labelReadout: [] };
    const d = decidir({ ...base, judgments: [j('A', none), j('B', none)] });
    expect(d).toMatchObject({ status: 'no-image', reviewReason: null });
  });

  it('"nenhuma" unânime sem referência → revisão', () => {
    const none = { decision: 'none' as const, imageIds: [], labelReadout: [] };
    const d = decidir({ ...base, reference: null, judgments: [j('A', none), j('B', none)] });
    expect(d).toMatchObject({ status: 'review', reviewReason: 'no-reference' });
  });
});

describe('rotuloCompativel', () => {
  it('aceita marca com acento diferente e quantidade em outra unidade', () => {
    expect(
      rotuloCompativel(
        { imageId: 'x', brand: 'UNIAO', variant: 'cristal', quantity: '1000g' },
        REF,
        DESC,
      ),
    ).toBe(true);
  });

  it('reprova marca diferente', () => {
    expect(rotuloCompativel({ ...LEITURA_OK, brand: 'Caravelas' }, REF, DESC)).toBe(false);
  });

  it('reprova rótulo sem quantidade quando a referência declara', () => {
    expect(rotuloCompativel({ ...LEITURA_OK, quantity: null }, REF, DESC)).toBe(false);
  });

  it('marca oficial com várias entradas separadas por vírgula', () => {
    const heinz = {
      ...REF,
      name: 'Ketchup Heinz 397g',
      brand: 'Heinz,Kraft Heinz',
      quantity: '397 g',
    };
    expect(
      rotuloCompativel(
        { imageId: 'x', brand: 'Heinz', variant: 'Tradicional', quantity: '397g' },
        heinz,
        'KETCHUP HEINZ 397G',
      ),
    ).toBe(true);
  });
});

describe('referência pelo cadastro do cliente (sem API externa)', () => {
  const erp = (descricao: string): EanReferenceRecord => ({
    ean: '7890000000000',
    source: 'erp',
    name: descricao,
    brand: null,
    quantity: null,
    imageUrl: null,
  });
  const leitura = (brand: string, variant: string | null, quantity: string | null) => ({
    imageId: 'x',
    brand,
    variant,
    quantity,
  });

  it.each([
    // [descrição do cadastro Arcos, marca/variante/quantidade lidas no rótulo, esperado]
    ['ACUCAR CRISTALCUCAR UNIÃO 1KG', leitura('União', 'Cristal', '1kg'), true],
    ['BISCOITO CLUB SOCIAL 141G QUEIJO', leitura('Club Social', 'Queijo', '141g'), true],
    ['LEITE PO NINHO 380G INTEGRAL', leitura('Nestlé Ninho', 'Integral', '380g'), true],
    ['AMACIANTE CONC YPE 500ML BLUE', leitura('Ypê', 'Blue', '500ml'), true],
    ['REQUEIJAO CREMOSO AVIACAO 180GR COPO', leitura('Aviação', 'Cremoso', '200g'), false], // gramatura
    ['REQUEIJAO CREMOSO AVIACAO 180GR COPO', leitura('Aviação', 'Cremoso', null), false], // sem quantidade no rótulo
    ['KETCHUP HEINZ 397G', leitura('Quero', 'Ketchup', '397g'), false], // outra marca
    ['BACON AURORA 1KG CUBOS', leitura('Aurora', 'Cubos', '1kg'), true],
  ])('%s × %o → %s', (descricao, l, esperado) => {
    expect(rotuloCompativel(l, erp(descricao), descricao)).toBe(esperado);
  });

  it('referência do cadastro não cai em "sem referência": auto-aceita com consenso', () => {
    const desc = 'ACUCAR CRISTALCUCAR UNIÃO 1KG';
    const d = decidir({
      reference: erp(desc),
      descricao: desc,
      calibracaoLiberada: true,
      judgments: [j('A'), j('B')],
    });
    expect(d.status).toBe('auto-accepted');
  });

  it('"nenhuma" unânime com referência do cadastro → sem imagem', () => {
    const none = { decision: 'none' as const, imageIds: [], labelReadout: [] };
    const desc = 'KETCHUP HEINZ 397G';
    const d = decidir({
      reference: erp(desc),
      descricao: desc,
      calibracaoLiberada: true,
      judgments: [j('A', none), j('B', none)],
    });
    expect(d.status).toBe('no-image');
  });
});

describe('leituras dos dois juízes precisam concordar', () => {
  const desc = 'INSETICIDA AEROSOL MAT INSET 270ML ACAO TOTAL';
  const ref: EanReferenceRecord = {
    ean: '7891035000000',
    source: 'erp',
    name: desc,
    brand: null,
    quantity: null,
    imageUrl: null,
  };
  const ler = (judge: 'A' | 'B', variant: string) =>
    j(judge, {
      imageIds: ['mat'],
      labelReadout: [{ imageId: 'mat', brand: 'MAT INSET', variant, quantity: '270ML' }],
    });

  it('caso real do piloto: A copiou "ACAO TOTAL" do cadastro, B leu "MULTI INSETICIDA ORIGINAL" → revisão', () => {
    const d = decidir({
      reference: ref,
      descricao: desc,
      calibracaoLiberada: true,
      judgments: [ler('A', 'ACAO TOTAL'), ler('B', 'MULTI INSETICIDA ORIGINAL')],
    });
    expect(d).toMatchObject({ status: 'review', reviewReason: 'label-mismatch' });
  });

  it('mesma leitura com grafia diferente → aceita', () => {
    const d = decidir({
      reference: ref,
      descricao: desc,
      calibracaoLiberada: true,
      judgments: [ler('A', 'Ação Total'), ler('B', 'ACAO TOTAL')],
    });
    expect(d.status).toBe('auto-accepted');
  });

  it.each([
    [
      { brand: 'UAU', variant: 'CLORO ATIVO', quantity: '500ml' },
      { brand: 'Uau', variant: 'Cloro Ativo', quantity: '500 ml' },
      true,
    ],
    [
      { brand: 'Nestlé Ninho', variant: 'Integral', quantity: '380g' },
      { brand: 'Ninho', variant: 'integral', quantity: '380 g' },
      true,
    ],
    [
      { brand: 'Aviação', variant: null, quantity: '200g' },
      { brand: 'Aviação', variant: null, quantity: '180g' },
      false,
    ],
    [
      { brand: 'Aviação', variant: 'com sal', quantity: '200g' },
      { brand: 'Aviação', variant: null, quantity: '200g' },
      false,
    ],
  ])('%o × %o → %s', (x, y, esperado) => {
    expect(leiturasEquivalentes({ imageId: 'i', ...x }, { imageId: 'i', ...y })).toBe(esperado);
  });
});
