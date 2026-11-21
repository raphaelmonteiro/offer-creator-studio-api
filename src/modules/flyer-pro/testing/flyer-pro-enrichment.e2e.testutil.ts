import { insertItems } from './flyer-pro-documents.fixture';
import { DocumentBody, envelope } from './flyer-pro-documents.e2e.testutil';
import type { FlyerProJobView } from '../views/flyer-pro-job.view';

/**
 * Ajudantes do e2e do job (só testes): as rotas do job, o encarte com itens, a espera por um estado do job (lendo pela
 * rota, como a tela) e a consulta ao lote na fila do banco de e2e. Recebe o que o `useDocumentsE2e` já montou.
 */

type Job = FlyerProJobView;

interface Deps {
  h: ReturnType<typeof import('./flyer-pro-documents.e2e.testutil').useDocumentsE2e>['h'];
  url: string;
  create: ReturnType<typeof import('./flyer-pro-documents.e2e.testutil').useDocumentsE2e>['create'];
}

export function enrichmentE2e({ h, url, create }: Deps) {
  const enrichment = (id: string) => `${url}/${id}/enrichment`;
  const jobOf = async (id: string) =>
    envelope<{ job: Job | null }>(await h.get(enrichment(id))).data.job;
  const startJob = (id: string, body: object) => h.post(enrichment(id), body);

  /** Um encarte com `count` itens de nomes variados, no cliente da semente. */
  async function documentWith(count: number, name = 'Ofertas Piccin semana 47') {
    const response = await create(h.seed.scenes.frontBack.id, { name });
    const { id } = envelope<DocumentBody>(response).data;
    const names = ['CERVEJA PILSEN', 'FILE DE TILAPIA CONJELADO', 'PRODUTO', 'PRODUTO'];
    await insertItems(
      h.dataSource,
      id,
      Array.from({ length: count }, (_, i) => ({ name: `${names[i % 4]} ${i}` })),
    );
    return id;
  }

  /** Espera o job do encarte chegar a um dos estados. */
  async function until(id: string, statuses: string[], timeoutMs = 80_000): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await jobOf(id);
      if (job && statuses.includes(job.status)) return job;
      if (Date.now() > deadline) {
        throw new Error(`job ${job?.status} (${statuses.join('|')} esperado)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  /** Quantos lotes do job estão (ou passaram) na fila do banco de e2e. */
  const queued = (jobId: string) =>
    h.dataSource.query(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'flyer_pro.enrich' AND data->>'jobId' = $1`,
      [jobId],
    );

  return { enrichment, jobOf, startJob, documentWith, until, queued };
}
