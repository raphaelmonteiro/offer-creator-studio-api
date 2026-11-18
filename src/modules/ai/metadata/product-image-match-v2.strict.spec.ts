import { TransientProviderError } from '../../../shared/providers/provider-errors';
import { ProductImageMatchV2Service } from './product-image-match-v2.service';

const PRODUCTS = [
  { id: 'p1', name: 'CERVEJA PILSEN LATA 350ML', category: null, unit: 'cada' },
  { id: 'p2', name: 'ABACATE KG', category: null, unit: 'kg' },
];

/** O casamento por nome com o leitor de nomes e o embedding simulados (a opção `strict` é o que se confere). */
function buildService() {
  const parseNames = jest.fn().mockResolvedValue([null, null]);
  const parseSingle = jest.fn().mockResolvedValue(null);
  const embedText = jest.fn().mockResolvedValue(null);
  const embedTexts = jest.fn(async (texts: string[], _options?: object) => texts.map(() => null));
  const service = new ProductImageMatchV2Service(
    { embedText, embedTexts } as never,
    { parseNames, parseSingle } as never,
    {} as never,
    { get: jest.fn().mockReturnValue('0') } as never,
  );
  return { service, parseNames, parseSingle, embedText, embedTexts };
}

describe('ProductImageMatchV2Service, modo estrito (change 28)', () => {
  it('com strict, repassa a opção ao leitor de nomes e ao embedding em lote dos dois produtos', async () => {
    const { service, parseNames, embedTexts } = buildService();

    await service.matchWithCandidates(PRODUCTS, null, { strict: true });

    expect(parseNames).toHaveBeenCalledWith(expect.any(Array), { strict: true });
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(embedTexts.mock.calls[0][0]).toHaveLength(2);
    expect(embedTexts.mock.calls[0][1]).toEqual({ strict: true });
  });

  it('findBestMatches e findCandidates não passam a opção', async () => {
    const { service, parseNames, parseSingle, embedText, embedTexts } = buildService();

    await service.findBestMatches(PRODUCTS, null);
    await service.findCandidates(PRODUCTS[0], 3, null);

    expect(parseSingle).toHaveBeenCalledTimes(1);
    expect(parseSingle.mock.calls[0][1]).toBeUndefined();
    for (const call of parseNames.mock.calls) expect(call[1]?.strict).toBeUndefined();
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(embedText).toHaveBeenCalledTimes(1);
    for (const call of [...embedText.mock.calls, ...embedTexts.mock.calls]) {
      expect(call[1]?.strict).toBeUndefined();
    }
  });

  it('429 na leitura de nomes com strict lança; sem a opção devolve o resultado vazio de hoje', async () => {
    const { service, parseNames } = buildService();
    parseNames.mockImplementation(async (_: unknown, options?: { strict?: boolean }) => {
      if (options?.strict) throw new TransientProviderError('HTTP 429');
      return [null, null];
    });

    await expect(service.matchWithCandidates(PRODUCTS, null, { strict: true })).rejects.toThrow(
      TransientProviderError,
    );
    const lenient = await service.matchWithCandidates(PRODUCTS, null);

    expect(lenient.result).toEqual({ matches: [], reviewCandidates: [], scanned: 2, matched: 0 });
  });
});
