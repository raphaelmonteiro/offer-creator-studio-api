import { randomUUID } from 'crypto';
import { useE2eHarness } from '../../shared/testing/e2e-harness';
import { describeIfE2eDb } from '../../shared/testing/e2e-test-db';
import { FlyerProClientGuardService } from '../flyer-pro/services/flyer-pro-client-guard.service';
import {
  createExtraUser,
  ExtraUser,
  insertClient,
  insertDocumentWithItems,
  purgeDocumentsOf,
} from '../flyer-pro/testing/flyer-pro-documents.fixture';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

const MESSAGE = 'Este cliente tem encartes. Exclua os encartes antes de excluir o cliente.';

interface Scenario {
  /** Encartes Pro vivos (2 itens cada). */
  live?: number;
  /** Encartes Pro excluídos logicamente (3 itens cada). */
  deleted?: number;
  /** Um documento do `/editor-v2`, gravado direto. */
  editorV2?: boolean;
}

/**
 * e2e da exclusão de cliente (change 10-handle-client-in-use-on-delete) sobre o harness da 05: guard JWT, pipe, filtro e
 * SQL reais. Cada cenário cria os clientes dele (CNPJ único por execução, 2 contatos e 1 loja) e confere as linhas no banco
 * depois da resposta; os clientes da semente não são excluídos. A corrida do encarte criado durante a exclusão e o erro de
 * banco que não é de chave estrangeira ficam nos unitários de `clients.remove.service.spec.ts`.
 */
describeIfE2eDb('DELETE /v1/clients/:id (e2e)', () => {
  const h = useE2eHarness({
    controllers: [ClientsController],
    providers: [ClientsService, FlyerProClientGuardService],
  });
  const created: string[] = [];
  let commonUser: ExtraUser;

  beforeAll(async () => {
    commonUser = await createExtraUser(h.dataSource, h.app.jwt, 'Usuário comum');
    h.onCleanup(async () => {
      await purgeDocumentsOf(h.dataSource, created);
      await h.dataSource.query(
        `DELETE FROM flyer_builder_v2_documents WHERE "clientId" = ANY($1::uuid[])`,
        [created],
      );
      await h.dataSource.query(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [created]);
      await commonUser.remove();
    });
  });

  /** Um cliente novo com 2 contatos e 1 loja, mais os encartes do cenário; devolve o id e os ids de todos os itens. */
  async function seedClient({ live = 0, deleted = 0, editorV2 = false }: Scenario = {}) {
    const id = await insertClient(h.dataSource, 'QA Exclusão');
    created.push(id);
    for (const n of [1, 2]) {
      await h.dataSource.query(
        `INSERT INTO client_contacts (name, role, email, phone, "clientId") VALUES ($1, 'Compras', $2, '1199', $3)`,
        [`Contato ${n}`, `c${n}@qa.test`, id],
      );
    }
    await h.dataSource.query(
      `INSERT INTO client_stores (name, "clientId") VALUES ('Loja Centro', $1)`,
      [id],
    );
    const itemIds: string[] = [];
    const add = async (count: number, items: number, deletedAt: Date | null) => {
      for (let i = 0; i < count; i += 1) {
        const doc = await insertDocumentWithItems(h.dataSource, { clientId: id, deletedAt }, items);
        itemIds.push(...doc.itemIds);
      }
    };
    await add(live, 2, null);
    await add(deleted, 3, new Date());
    if (editorV2) {
      await h.dataSource.query(
        `INSERT INTO flyer_builder_v2_documents (name, "clientId", document) VALUES ('Encarte do editor v2', $1, '{}')`,
        [id],
      );
    }
    return { id, itemIds };
  }

  /** As linhas do cliente no banco: ele, contatos, loja, encartes Pro vivos e excluídos, itens e documentos do editor v2. */
  async function rows(clientId: string, itemIds: string[] = []) {
    const [row] = await h.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM clients WHERE id = $1) AS client,
         (SELECT count(*)::int FROM client_contacts WHERE "clientId" = $1) AS contacts,
         (SELECT count(*)::int FROM client_stores WHERE "clientId" = $1) AS stores,
         (SELECT count(*)::int FROM flyer_pro_documents WHERE "clientId" = $1 AND "deletedAt" IS NULL) AS live,
         (SELECT count(*)::int FROM flyer_pro_documents WHERE "clientId" = $1 AND "deletedAt" IS NOT NULL) AS deleted,
         (SELECT count(*)::int FROM flyer_pro_items WHERE id = ANY($2::uuid[])) AS items,
         (SELECT count(*)::int FROM flyer_builder_v2_documents WHERE "clientId" = $1) AS "editorV2"`,
      [clientId, itemIds],
    );
    return row;
  }

  const remove = (id: string) => h.delete(`/clients/${id}`);
  const expectInUse = (response: { status: number; body: unknown }, flyerProDocuments: number) => {
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      success: false,
      error: { code: 'CLIENT_IN_USE', message: MESSAGE, details: { flyerProDocuments } },
    });
  };
  const expectRemoved = (response: { status: number; body: unknown }) => {
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { message: 'Cliente removido com sucesso' },
    });
  };

  it('2 encartes Pro vivos: 409 com a contagem e nada sai', async () => {
    const { id, itemIds } = await seedClient({ live: 2 });

    expectInUse(await remove(id), 2);

    expect(await rows(id, itemIds)).toEqual({
      client: 1,
      contacts: 2,
      stores: 1,
      live: 2,
      deleted: 0,
      items: 4,
      editorV2: 0,
    });
  });

  it('recusa repetida: 409 de novo com a mesma contagem', async () => {
    const { id, itemIds } = await seedClient({ live: 2 });

    expectInUse(await remove(id), 2);
    expectInUse(await remove(id), 2);

    expect((await rows(id, itemIds)).items).toBe(4);
  });

  it('só encartes excluídos: 200, e o cliente, os contatos, a loja, os encartes e os itens saem', async () => {
    const { id, itemIds } = await seedClient({ deleted: 2 });

    expectRemoved(await remove(id));

    expect(await rows(id, itemIds)).toEqual({
      client: 0,
      contacts: 0,
      stores: 0,
      live: 0,
      deleted: 0,
      items: 0,
      editorV2: 0,
    });
  });

  it('encarte excluído de outro cliente fica, com os itens', async () => {
    const mine = await seedClient({ deleted: 1 });
    const other = await seedClient({ deleted: 1 });

    expectRemoved(await remove(mine.id));

    expect(await rows(mine.id, mine.itemIds)).toMatchObject({ client: 0, deleted: 0, items: 0 });
    expect(await rows(other.id, other.itemIds)).toMatchObject({ client: 1, deleted: 1, items: 3 });
  });

  it('só documento do /editor-v2: 409 com 0 e o documento continua (era 500)', async () => {
    const { id } = await seedClient({ editorV2: true });

    expectInUse(await remove(id), 0);

    expect(await rows(id)).toMatchObject({ client: 1, contacts: 2, stores: 1, editorV2: 1 });
  });

  it('sem encartes: 200 e os contatos e a loja saem junto; repetir dá 404', async () => {
    const { id } = await seedClient();

    expectRemoved(await remove(id));
    expect(await rows(id)).toMatchObject({ client: 0, contacts: 0, stores: 0 });

    const again = await remove(id);
    expect(again.status).toBe(404);
    expect(again.body.error).toMatchObject({
      code: 'CLIENT_NOT_FOUND',
      message: 'Cliente não encontrado',
    });
  });

  it('encarte vivo e excluído: 409 com 1, a transação volta e o excluído continua com os itens', async () => {
    const { id, itemIds } = await seedClient({ live: 1, deleted: 1 });

    expectInUse(await remove(id), 1);

    expect(await rows(id, itemIds)).toMatchObject({ client: 1, live: 1, deleted: 1, items: 5 });
  });

  it('encarte Pro vivo e documento do /editor-v2: 409 com 1, nada sai', async () => {
    const { id, itemIds } = await seedClient({ live: 1, editorV2: true });

    expectInUse(await remove(id), 1);

    expect(await rows(id, itemIds)).toMatchObject({ client: 1, live: 1, editorV2: 1, items: 2 });
  });

  it('documento do /editor-v2 e encarte Pro excluído: 409 com 0 e o expurgo volta com a recusa', async () => {
    const { id, itemIds } = await seedClient({ deleted: 1, editorV2: true });

    expectInUse(await remove(id), 0);

    expect(await rows(id, itemIds)).toMatchObject({ client: 1, deleted: 1, editorV2: 1, items: 3 });
  });

  it('id que não existe: 404 e o encarte excluído de outro cliente continua', async () => {
    const other = await seedClient({ deleted: 1 });

    const response = await remove(randomUUID());

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'CLIENT_NOT_FOUND',
      message: 'Cliente não encontrado',
    });
    expect(await rows(other.id, other.itemIds)).toMatchObject({ client: 1, deleted: 1, items: 3 });
  });

  it('id que não é UUID: 400 INVALID_JSON', async () => {
    const response = await remove('abc');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });

  it('sem token: 401 e o cliente continua', async () => {
    const { id } = await seedClient();

    const response = await h.http().delete(`/v1/clients/${id}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect((await rows(id)).client).toBe(1);
  });

  it('usuário comum (sem papel de admin): 200', async () => {
    const { id } = await seedClient();

    const response = await h
      .http()
      .delete(`/v1/clients/${id}`)
      .set('Authorization', `Bearer ${commonUser.token}`);

    expectRemoved(response);
    expect((await rows(id)).client).toBe(0);
  });
});
