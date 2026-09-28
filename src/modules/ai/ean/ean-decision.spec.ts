import { decidir, rotuloCompativel } from './ean-decision';
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
