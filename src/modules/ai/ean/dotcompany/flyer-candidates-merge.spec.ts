import { mergeCandidates } from './flyer-candidates-merge';
import { scoredOf } from './flyer-ean-resolution.candidates.testutil';

describe('mergeCandidates', () => {
  it('mantém a ordem dos grupos e a de cada grupo', () => {
    const result = mergeCandidates(
      [[scoredOf('a', 1)], [scoredOf('b', 0)], [scoredOf('c', 0.5)]],
      12,
    );
    expect(result.map((candidate) => candidate.imageId)).toEqual(['a', 'b', 'c']);
  });

  it('foto repetida fica na posição do primeiro grupo, com o primeiro score e os motivos somados', () => {
    const result = mergeCandidates(
      [
        [scoredOf('a', 1, ['EAN igual'])],
        [scoredOf('a', 0, ['nome escolhido antes']), scoredOf('b', 0, ['nome escolhido antes'])],
        [scoredOf('a', 0.7, ['EAN igual', 'categoria igual'])],
      ],
      12,
    );
    expect(result).toEqual([
      expect.objectContaining({
        imageId: 'a',
        score: 1,
        reasons: ['EAN igual', 'nome escolhido antes', 'categoria igual'],
      }),
      expect.objectContaining({ imageId: 'b' }),
    ]);
  });

  it('não muda as candidatas que recebeu', () => {
    const original = scoredOf('a', 0.9, ['x']);
    mergeCandidates([[original], [scoredOf('a', 0.5, ['y'])]], 12);
    expect(original.reasons).toEqual(['x']);
  });

  it.each([
    [2, 2],
    [0, 1],
    [100, 24],
  ])('limit %i devolve no máximo %i (de 1 a 24)', (limit, expected) => {
    const group = Array.from({ length: 30 }, (_, index) => scoredOf(`p${index}`, 0));
    expect(mergeCandidates([group], limit)).toHaveLength(expected);
  });
});
