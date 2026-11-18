import { AiUsageCollector } from '../../ai/utils/ai-usage';
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
