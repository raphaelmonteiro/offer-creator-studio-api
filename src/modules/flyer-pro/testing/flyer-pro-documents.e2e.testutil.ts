import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { useE2eHarness } from '../../../shared/testing/e2e-harness';
import { FlyerProModule } from '../flyer-pro.module';
import type {
  FlyerProDocumentListItemView,
  FlyerProDocumentView,
} from '../views/flyer-pro-document.view';
import {
  createExtraUser,
  ExtraUser,
  insertClient,
  purgeDocumentsOf,
} from './flyer-pro-documents.fixture';
import { createFlyerProFixture, FlyerProFixture } from './flyer-pro-scene-fixture';
import { e2eDataSourceModule } from './flyer-pro-templates.e2e.testutil';

/** Ajudantes do e2e das rotas do encarte (só testes): o envelope, o corpo do `POST` e as consultas ao banco. */

export interface Envelope<T> {
  success: boolean;
  data: T;
  pagination?: { page: number; limit: number; total: number; totalPages: number };
  error?: { code: string; message: string; details?: unknown };
}

export type DocumentBody = FlyerProDocumentView & { replayed?: boolean };
export type ListEntry = FlyerProDocumentListItemView;

/** O corpo de uma resposta já tipado como o envelope da rota. */
export const envelope = <T>(response: { body: unknown }): Envelope<T> =>
  response.body as Envelope<T>;

/** O `POST` de criação com os seis campos do contrato; `over` troca ou acrescenta o que o caso pede. */
export const createPayload = (
  ids: { clientId: string; sceneId: string },
  over: Record<string, unknown> = {},
) => ({
  creationKey: randomUUID(),
  name: 'Ofertas Piccin semana 47',
  schemaVersion: 1,
  engineVersion: 1,
  ...ids,
  ...over,
});

/** O corpo de um `PATCH` com os quatro obrigatórios, na revisão dada e com um `mutationId` novo; `over` troca ou acrescenta. */
export const savePayload = (revision: number, over: Record<string, unknown> = {}) => ({
  mutationId: randomUUID(),
  expectedRevision: revision,
  schemaVersion: 1,
  engineVersion: 1,
  ...over,
});

/** O item novo mínimo de um `upsert` (completo, com um `id` novo); `over` troca ou acrescenta. */
export const newItemPayload = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  position: 0,
  name: 'ABACATE',
  price: { kind: 'simple', cents: 699 },
  unit: 'kg',
  ...over,
});

/** `count` itens novos ligados à importação, nas posições a partir de `first` (os itens do cenário "Importar a lista do Piccin"). */
export const importedItemsPayload = (importId: string, count: number, first = 0) =>
  Array.from({ length: count }, (_, index) =>
    newItemPayload({ position: first + index, name: `PRODUTO ${first + index}`, importId }),
  );

export type Row = Record<string, unknown>;

/** A linha do encarte como o banco a guarda (sem passar pela view). */
export async function rowOf(dataSource: DataSource, id: string): Promise<Row> {
  const [row] = await dataSource.query(`SELECT * FROM flyer_pro_documents WHERE id = $1`, [id]);
  return row;
}

export async function countByKey(dataSource: DataSource, creationKey: string): Promise<number> {
  const [{ n }] = await dataSource.query(
    `SELECT count(*)::int AS n FROM flyer_pro_documents WHERE "creationKey" = $1`,
    [creationKey],
  );
  return n;
}

export async function countItems(dataSource: DataSource, documentId: string): Promise<number> {
  const [{ n }] = await dataSource.query(
    `SELECT count(*)::int AS n FROM flyer_pro_items WHERE "documentId" = $1`,
    [documentId],
  );
  return n;
}

/** O `createdAt` do encarte em UTC com microssegundos, como o `itemsCursor` o escreve. */
export async function createdAtText(dataSource: DataSource, id: string): Promise<string> {
  const [{ text }] = await dataSource.query(
    `SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS text
       FROM flyer_pro_documents WHERE id = $1`,
    [id],
  );
  return text;
}

export const DOCUMENTS_URL = '/flyer-pro/documents';

/**
 * O preparo comum dos specs de e2e das rotas do encarte: o harness com o `FlyerProModule`, um segundo usuário (Bruno), as
 * cenas da fixture da 07 (só com `scenes: true`, porque projetar as faces leva alguns segundos) e a limpeza dos encartes
 * e dos clientes da suíte antes da limpeza da semente (a FK `RESTRICT` do cliente barra a ordem inversa). Com `jobQueue`, o
 * app sobe a fila real no banco de e2e e o consumidor do job no próprio processo (só os specs do job). Chame no corpo do
 * `describeIfE2eDb`.
 */
export function useDocumentsE2e(options: { scenes: boolean; jobQueue?: boolean }) {
  const h = useE2eHarness({
    imports: [e2eDataSourceModule(() => h.dataSource), FlyerProModule],
    jobQueue: options.jobQueue,
  });
  let fixture: FlyerProFixture | undefined;
  let bruno: ExtraUser;
  const extraClients: string[] = [];
  const url = DOCUMENTS_URL;
  const clientA = () => h.seed.clientWithLibrary.id;

  beforeAll(async () => {
    if (options.scenes) {
      fixture = await createFlyerProFixture(h.dataSource, {
        uploadsDir: h.uploadsDir,
        cdnUrl: h.app.config.get<string>('CDN_URL') as string,
      });
    }
    bruno = await createExtraUser(h.dataSource, h.app.jwt, 'Bruno');
    h.onCleanup(async () => {
      await purgeDocumentsOf(h.dataSource, [
        clientA(),
        h.seed.clientLegacyFooter.id,
        ...extraClients,
      ]);
      await h.dataSource.query(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [extraClients]);
      await bruno.remove();
      await fixture?.cleanup();
    });
  }, 240_000);

  const list = async (query: string) => envelope<ListEntry[]>(await h.get(`${url}?${query}`));
  return {
    h,
    url,
    clientA,
    fixture: () => fixture as FlyerProFixture,
    bruno: () => bruno,
    /** Os cabeçalhos do Bruno, para chamar uma rota como outro usuário. */
    asBruno: () => ({ Authorization: `Bearer ${bruno.token}` }),
    noToken: (path: string) => h.http().get(`/v1${path}`),
    /** `PATCH` do N4 com o token da semente (a Ana); `PUT` do cursor; e o `PATCH` como outro usuário. */
    patch: (id: string, body: object) => h.patch(`${url}/${id}`, body),
    patchAs: (headers: Record<string, string>, id: string, body: object) =>
      h.http().patch(`/v1${url}/${id}`).set(headers).send(body),
    put: (path: string, body: object) => h.authed(h.http().put(`/v1${url}/${path}`)).send(body),
    /** `POST` do N1 na cena dada (a de frente e verso da semente, por padrão); devolve o encarte criado. */
    newDocument: async (sceneId = h.seed.scenes.frontBack.id) =>
      envelope<DocumentBody>(await h.post(url, createPayload({ clientId: clientA(), sceneId })))
        .data,
    /** Um cliente novo da suíte, apagado na limpeza. */
    newClient: async (name?: string) => {
      const id = await insertClient(h.dataSource, name);
      extraClients.push(id);
      return id;
    },
    /** `POST` do N1 com a cena dada, no cliente da semente (ou no dado). */
    create: (sceneId: string, over: Record<string, unknown> = {}, clientId = clientA()) =>
      h.post(url, createPayload({ clientId, sceneId }, over)),
    open: async (id: string) => envelope<DocumentBody>(await h.get(`${url}/${id}`)).data,
    list,
    names: async (query: string) => (await list(query)).data.map((entry) => entry.name),
  };
}
