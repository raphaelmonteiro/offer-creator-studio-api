import { EanCalibrationService, medir, wilsonLower } from './ean-calibration.service';
import type { AiDecisionRecord, HumanDecisionRecord } from './ean-match.types';

const ai = (imageIds: string[], elegivel = true): AiDecisionRecord => ({
  decision: imageIds.length ? 'match' : 'none',
  imageIds,
  consensus: true,
  autoAcceptEligible: elegivel,
  failed: [],
});
const humano = (decision: 'match' | 'none', imageIds: string[]): HumanDecisionRecord => ({
  decision,
  imageIds,
  userId: 'u',
  decidedAt: '2026-09-28T00:00:00Z',
});

function linhas(certos: number, errados: number) {
  return [
    ...Array.from({ length: certos }, (_, i) => ({
      aiDecision: ai([`img${i}`]),
      humanDecision: humano('match', [`img${i}`]),
    })),
    ...Array.from({ length: errados }, (_, i) => ({
      aiDecision: ai([`x${i}`]),
      humanDecision: humano('match', [`y${i}`]),
    })),
  ];
}

describe('calibração', () => {
  it('200/200 corretos → aprovado (Wilson ≥ 98%)', () => {
    const r = medir(linhas(200, 0), 'v1');
    expect(r.precisao).toBe(1);
    expect(r.wilsonInferior).toBeGreaterThanOrEqual(0.98);
    expect(r.aprovado).toBe(true);
  });

  it('196/200 → reprovado', () => {
    const r = medir(linhas(196, 4), 'v1');
    expect(r.precisao).toBeCloseTo(0.98);
    expect(r.aprovado).toBe(false);
  });

  it('100/100 → reprovado: amostra pequena demais para o limite inferior', () => {
    const r = medir(linhas(100, 0), 'v1');
    expect(r.precisao).toBe(1);
    expect(r.wilsonInferior).toBeLessThan(0.98);
    expect(r.aprovado).toBe(false);
  });

  it('IA grava uma foto e humano escolhe duas do mesmo SKU → correto', () => {
    const r = medir([{ aiDecision: ai(['a']), humanDecision: humano('match', ['a', 'b']) }], 'v1');
    expect(r.corretos).toBe(1);
  });

  it('IA aceitaria e humano disse "nenhuma" → erro', () => {
    const r = medir([{ aiDecision: ai(['a']), humanDecision: humano('none', []) }], 'v1');
    expect(r.corretos).toBe(0);
    expect(r.autoAceitos).toBe(1);
  });

  it('"nenhuma" da IA não conta na precisão, só na cobertura; não-elegíveis não contam', () => {
    const r = medir(
      [
        { aiDecision: ai([]), humanDecision: humano('none', []) },
        { aiDecision: ai(['a'], false), humanDecision: humano('match', ['b']) },
      ],
      'v1',
    );
    expect(r.autoAceitos).toBe(0);
    expect(r.cobertura).toBe(0.5);
  });

  it('wilsonLower bate com a tabela (0/0 = 0; 200/200 ≈ 98,1%)', () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(200, 200)).toBeCloseTo(0.9812, 3);
  });

  it('trocar a versão do juiz desliga o auto-aceite', async () => {
    const settings = { get: jest.fn().mockResolvedValue({ ...medir(linhas(200, 0), 'v1') }) };
    const service = new EanCalibrationService({} as never, settings as never);
    expect(await service.autoAceiteLiberado('v1')).toBe(true);
    expect(await service.autoAceiteLiberado('v2')).toBe(false);
  });
});
