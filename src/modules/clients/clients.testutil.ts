import type { EntityManager } from 'typeorm';
import { FlyerProClientGuardService } from '../flyer-pro/services/flyer-pro-client-guard.service';
import { Client } from './entities/client.entity';
import { ClientsService } from './clients.service';

/** Repositório de `Client` em memória (sem banco): só o que o `ClientsService` usa nos testes. */
export class FakeClientRepository {
  readonly rows = new Map<string, Client>();
  /** A ordem das chamadas da exclusão (`purge`, `remove`), que o dublê do serviço de guarda também escreve. */
  readonly calls: string[] = [];
  /** Erro que a remoção do cliente lança, para simular a recusa do banco (`remove` da transação). */
  removeError?: Error;
  private seq = 0;

  /** Só o que o `remove` do serviço usa: a transação, que roda o trabalho sobre este mesmo `manager`. */
  readonly manager = {
    transaction: async (work: (manager: EntityManager) => Promise<void>) =>
      work(this.manager as unknown as EntityManager),
    remove: async (client: Client) => {
      this.calls.push('remove');
      if (this.removeError) throw this.removeError;
      this.rows.delete(client.id);
    },
  };

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

/** Dublê do serviço de guarda do Encarte Pro: o expurgo e a contagem registram a ordem em `calls`. */
export function fakeClientGuard(calls: string[] = [], liveDocuments = 0) {
  return {
    purgeDeletedOfClient: jest.fn(async () => {
      calls.push('purge');
      return [];
    }),
    countLiveOfClient: jest.fn(async () => liveDocuments),
  };
}

export function buildClientsService(
  repo = new FakeClientRepository(),
  guard = fakeClientGuard(repo.calls),
) {
  const service = new ClientsService(
    repo as never,
    fakeChildRepository() as never,
    fakeChildRepository() as never,
    guard as unknown as FlyerProClientGuardService,
  );
  return { service, repo, guard };
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
