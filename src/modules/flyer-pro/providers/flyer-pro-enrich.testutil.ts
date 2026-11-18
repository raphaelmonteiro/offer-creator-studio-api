import { AiUsageCollector } from '../../ai/utils/ai-usage';
import { MockFlyerProEnrich } from './flyer-pro-enrich.mock';
import type { EnrichCallContext, EnrichItemInput } from './flyer-pro-enrich.port';

/** O contexto de uma chamada ao provedor, com o coletor de uso e o sinal de cancelamento que o processador criaria. */
export const callContext = (
  documentName = 'Ofertas Piccin semana 47',
  over: Partial<EnrichCallContext> = {},
): EnrichCallContext => ({
  jobId: 'job-1',
  documentName,
  clientId: 'client-1',
  usage: new AiUsageCollector(),
  signal: new AbortController().signal,
  pass: 0,
  notes: { nameSearchUnavailable: false },
  ...over,
});

/** Um item como o provedor o lê (só o que as três fases usam). */
export const itemInput = (name: string, over: Partial<EnrichItemInput> = {}): EnrichItemInput => ({
  id: `id-${name}`,
  name,
  sourceName: null,
  category: null,
  categorySource: null,
  unit: 'cada',
  ean: null,
  position: 0,
  imported: null,
  ...over,
});

/** As fotos da Galeria que o simulado usa nos testes: 40 imagens, cada uma com a miniatura. */
export const galleryPhotos = Array.from({ length: 40 }, (_, index) => ({
  id: `foto-${index}`,
  url: `http://localhost:3101/uploads/gallery/foto-${index}.jpg`,
  thumbnailUrl: `http://localhost:3101/uploads/thumbnails/foto-${index}.jpg`,
}));

/** O simulado sobre uma Galeria de teste, uma medida de 600×1200 e uma espera que não espera (os marcadores `#ia-lenta`). */
export function buildMock(
  over: { photos?: typeof galleryPhotos; measure?: jest.Mock; sleep?: jest.Mock } = {},
) {
  const first = jest.fn(async (limit: number) => (over.photos ?? galleryPhotos).slice(0, limit));
  const measure = over.measure ?? jest.fn(async () => ({ width: 600, height: 1200 }));
  const sleep = over.sleep ?? jest.fn(async () => undefined);
  return { port: new MockFlyerProEnrich({ first }, { measure }, sleep), first, measure, sleep };
}
