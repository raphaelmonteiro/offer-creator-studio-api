import { callContext, itemInput } from '../providers/flyer-pro-enrich.testutil';
import { EnrichImagePhase, PHOTO_MEASURE_CONCURRENCY } from './enrich-image-phase';

const items = Array.from({ length: 16 }, (_, index) =>
  itemInput(`PRODUTO ${index}`, { id: `p-${index}` }),
);

/** Uma busca que acha uma foto para cada um dos 16 itens (só `matches` importa para a medida). */
const findImages = jest.fn().mockResolvedValue({
  matches: items.map((item, index) => ({
    productId: item.id,
    imageId: `img-${index}`,
    imageUrl: `https://fora.exemplo/foto-${index}.png`,
    score: 0.9,
    reasons: [],
    isClientPreferred: false,
  })),
  reviewCandidates: [],
  pending: [],
  eanStatus: [],
});

/** O medidor que lembra o pico de medidas em andamento; cada uma demora um instante, como um download. */
function trackedSizes() {
  let running = 0;
  const stats = { peak: 0, calls: [] as string[] };
  const measure = jest.fn(async (url: string, _options?: { signal?: AbortSignal }) => {
    running += 1;
    stats.peak = Math.max(stats.peak, running);
    stats.calls.push(url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return { width: 800, height: 600 };
  });
  return { measure, stats };
}

describe('EnrichImagePhase: medida das fotos do lote (D-orq-2)', () => {
  it('16 fotos no lote: no máximo 4 medidas ao mesmo tempo, e todas as fotos são medidas e aplicadas', async () => {
    const { measure, stats } = trackedSizes();
    const phase = new EnrichImagePhase({ findImages }, { isEnabled: () => true }, { measure });

    const verdicts = await phase.run(items, callContext());

    expect(PHOTO_MEASURE_CONCURRENCY).toBe(4);
    expect(stats.peak).toBe(4);
    expect(stats.calls).toHaveLength(16);
    expect(verdicts.map((verdict) => verdict.action)).toEqual(Array(16).fill('apply'));
  });

  it('o sinal do lote chega a cada medida', async () => {
    const { measure } = trackedSizes();
    const phase = new EnrichImagePhase({ findImages }, { isEnabled: () => true }, { measure });
    const context = callContext();

    await phase.run(items, context);

    expect(measure.mock.calls.every(([, options]) => options.signal === context.signal)).toBe(true);
  });
});
