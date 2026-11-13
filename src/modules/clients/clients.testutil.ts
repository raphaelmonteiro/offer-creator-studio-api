import { Client } from './entities/client.entity';
import { ClientsService } from './clients.service';

/** Repositório de `Client` em memória (sem banco): só o que o `ClientsService` usa nos testes. */
export class FakeClientRepository {
  readonly rows = new Map<string, Client>();
  private seq = 0;

  create(data: Partial<Client>): Client {
    return { contacts: [], stores: [], ...data } as Client;
  }

  async save(client: Client): Promise<Client> {
    if (!client.id) client.id = `c-${++this.seq}`;
    this.rows.set(client.id, structuredClone(client));
    return client;
  }

  async findOne(opts: { where: { id?: string; cnpj?: string } }): Promise<Client | null> {
    const { id, cnpj } = opts.where;
    const found = [...this.rows.values()].find((r) => (id ? r.id === id : r.cnpj === cnpj));
    return found ? structuredClone(found) : null;
  }
}

export const fakeChildRepository = () => ({
  create: (data: unknown) => data,
  save: async (data: unknown) => data,
  delete: async () => undefined,
});

export function buildClientsService(repo = new FakeClientRepository()) {
  const service = new ClientsService(
    repo as never,
    fakeChildRepository() as never,
    fakeChildRepository() as never,
  );
  return { service, repo };
}

export const SECTION = { id: 's', width: 540, height: 400, elements: [] };
export const headerItem = (id: string, name: string) => ({
  id,
  name,
  format: '27x40',
  section: SECTION,
});
export const footerItem = (id: string, name: string) => ({ id, name, section: SECTION });
export const baseClient = (cnpj: string) => ({ name: 'Cliente', cnpj });
