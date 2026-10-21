import { canonicalEan, planManualEanLink } from './gallery-image-ean.service';

const NOW = '2026-10-21T12:00:00.000Z';
const EAN = '7891000100103';
const OUTRO = '7896004400013';

describe('canonicalEan', () => {
  it('aceita EAN-13 válido e limpa separadores', () => {
    expect(canonicalEan(' 789.1000.100103 ')).toBe(EAN);
  });

  it('normaliza UPC-A e GTIN-14 com zero à esquerda para 13 dígitos', () => {
    expect(canonicalEan('036000291452')).toBe('0036000291452');
    expect(canonicalEan(`0${EAN}`)).toBe(EAN);
  });

  it('recusa dígito verificador errado, comprimento fora do padrão e vazio', () => {
    expect(canonicalEan('7891000100104')).toBeNull();
    expect(canonicalEan('12345')).toBeNull();
    expect(canonicalEan('')).toBeNull();
    expect(canonicalEan(null)).toBeNull();
  });
});

describe('planManualEanLink', () => {
  it('imagem sem metadata recebe o bloco EAN manual/human', () => {
    const plan = planManualEanLink(null, EAN, { productName: 'DOCE DE LEITE 350G', now: NOW });
    expect(plan.status).toBe('linked');
    expect(plan.previousEan).toBeNull();
    expect(plan.metadata).toMatchObject({
      ean: EAN,
      eanSource: 'manual',
      eanVerifiedBy: 'human',
      eanConfidence: 1,
      eanStatus: 'resolved',
      eanVerifiedAt: NOW,
      eanJobId: null,
      warnings: ['ean-manual: escolhida no encarte "DOCE DE LEITE 350G"'],
    });
    expect(plan.metadata).not.toHaveProperty('eanCandidates');
  });

  it('preserva os campos descritivos já extraídos', () => {
    const current = { title: 'Doce de leite', ean: null, warnings: ['x'], alternatives: [] };
    const plan = planManualEanLink(current, EAN, { now: NOW });
    expect(plan.status).toBe('linked');
    expect(plan.metadata).toMatchObject({ title: 'Doce de leite', alternatives: [] });
    expect(plan.metadata?.warnings).toEqual(['x', 'ean-manual: escolhida no encarte']);
  });

  it('mesmo EAN (mesmo com zero à esquerda) não muda nada, nem a proveniência', () => {
    const current = { ean: `0${EAN}`, eanSource: 'dotcompany', eanVerifiedBy: 'exact' };
    const plan = planManualEanLink(current, EAN);
    expect(plan.status).toBe('unchanged');
    expect(plan.metadata).toBeNull();
  });

  it('EAN diferente é substituído e o anterior fica em candidates e warnings', () => {
    const current = {
      title: 'Pudim',
      ean: OUTRO,
      eanSource: 'off',
      eanConfidence: 0.7,
      warnings: [],
    };
    const plan = planManualEanLink(current, EAN, { now: NOW });
    expect(plan.status).toBe('replaced');
    expect(plan.previousEan).toBe(OUTRO);
    expect(plan.previousSource).toBe('off');
    expect(plan.metadata).toMatchObject({ ean: EAN, eanSource: 'manual', eanVerifiedBy: 'human' });
    expect(plan.metadata?.eanCandidates).toEqual([
      expect.objectContaining({ ean: OUTRO, source: 'off', score: 0.7 }),
    ]);
    expect(plan.metadata?.warnings).toEqual([
      'ean-manual: escolhida no encarte',
      `ean-anterior:${OUTRO}:off`,
    ]);
  });

  it('a última escolha humana vale sobre uma escolha manual anterior', () => {
    const current = { ean: OUTRO, eanSource: 'manual', eanVerifiedBy: 'human' };
    const plan = planManualEanLink(current, EAN);
    expect(plan.status).toBe('replaced');
    expect(plan.metadata?.ean).toBe(EAN);
  });

  it('EAN legado sem fonte é substituído sem inventar candidate', () => {
    const current = { ean: OUTRO };
    const plan = planManualEanLink(current, EAN);
    expect(plan.status).toBe('replaced');
    expect(plan.metadata).not.toHaveProperty('eanCandidates');
    expect(plan.metadata?.warnings).toContain(`ean-anterior:${OUTRO}`);
  });
});
