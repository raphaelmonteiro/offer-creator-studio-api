import { buildEanJudgeSystemPrompt, JudgeOutputSchema } from './ean-judge.prompts';

const ok = (o: object) => JudgeOutputSchema.safeParse(o).success;
const label = (image: string) => ({ image, brand: 'União', variant: 'cristal', quantity: '1kg' });

describe('JudgeOutputSchema', () => {
  it.each([
    [
      'match com 1 imagem',
      { decision: 'match', images: ['A'], labels: [label('A')], reason: 'rótulo cristal 1kg' },
      true,
    ],
    [
      'same-sku com 2',
      {
        decision: 'same-sku-multiple',
        images: ['A', 'C'],
        labels: [label('A'), label('C')],
        reason: 'x',
      },
      true,
    ],
    [
      'none sem imagens',
      { decision: 'none', images: [], labels: [], reason: 'nenhuma é ketchup' },
      true,
    ],
    [
      'match com 2 imagens',
      { decision: 'match', images: ['A', 'B'], labels: [label('A'), label('B')], reason: 'x' },
      false,
    ],
    [
      'same-sku com 1',
      { decision: 'same-sku-multiple', images: ['A'], labels: [label('A')], reason: 'x' },
      false,
    ],
    [
      'none com imagem',
      { decision: 'none', images: ['A'], labels: [label('A')], reason: 'x' },
      false,
    ],
    [
      'imagem sem leitura de rótulo',
      { decision: 'match', images: ['A'], labels: [], reason: 'x' },
      false,
    ],
    ['decisão desconhecida', { decision: 'maybe', images: [], labels: [], reason: 'x' }, false],
    ['sem justificativa', { decision: 'none', images: [], labels: [], reason: '' }, false],
    [
      'letra minúscula',
      { decision: 'match', images: ['a'], labels: [label('a')], reason: 'x' },
      false,
    ],
  ])('%s → válido=%s', (_n, o, esperado) => {
    expect(ok(o)).toBe(esperado);
  });
});

describe('buildEanJudgeSystemPrompt', () => {
  it('A e B têm enquadramentos diferentes e ambos permitem "none"', () => {
    const a = buildEanJudgeSystemPrompt('A');
    const b = buildEanJudgeSystemPrompt('B');
    expect(a).not.toBe(b);
    expect(b).toMatch(/PRIMEIRO elimine/);
    for (const p of [a, b]) expect(p).toMatch(/"none"/);
  });
});
