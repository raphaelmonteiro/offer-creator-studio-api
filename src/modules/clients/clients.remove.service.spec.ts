import { ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import {
  baseClient,
  buildClientsService,
  fakeClientGuard,
  FakeClientRepository,
} from './clients.testutil';

const MESSAGE = 'Este cliente tem encartes. Exclua os encartes antes de excluir o cliente.';

/** Falha do driver como o TypeORM a entrega: `QueryFailedError` com o `code` do Postgres em `driverError`. */
const queryFailed = (code: string) =>
  new QueryFailedError('DELETE FROM "clients"', [], Object.assign(new Error('falhou'), { code }));

async function setup(liveDocuments = 0) {
  const repo = new FakeClientRepository();
  const guard = fakeClientGuard(repo.calls, liveDocuments);
  const { service } = buildClientsService(repo, guard);
  const client = await service.create(baseClient('remove-1'));
  return { service, repo, guard, client };
}

describe('ClientsService.remove', () => {
  it('caminho feliz: expurga os encartes excluídos do cliente e depois remove o cliente, sem contar nada', async () => {
    const { service, repo, guard, client } = await setup();

    await expect(service.remove(client.id)).resolves.toBeUndefined();

    expect(repo.calls).toEqual(['purge', 'remove']);
    expect(guard.purgeDeletedOfClient).toHaveBeenCalledWith(repo.manager, client.id);
    expect(guard.countLiveOfClient).not.toHaveBeenCalled();
    expect(repo.rows.has(client.id)).toBe(false);
  });

  it.each([
    ['2 encartes vivos', 2],
    ['só documento de outra tabela', 0],
  ])(
    'recusa por chave estrangeira (23503), %s: 409 CLIENT_IN_USE com a contagem depois da recusa',
    async (_name, live) => {
      const { service, repo, guard, client } = await setup(live);
      repo.removeError = queryFailed('23503');

      const failure = await service.remove(client.id).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getStatus()).toBe(409);
      expect((failure as ConflictException).getResponse()).toEqual({
        code: 'CLIENT_IN_USE',
        message: MESSAGE,
        details: { flyerProDocuments: live },
      });
      expect(guard.countLiveOfClient).toHaveBeenCalledWith(client.id);
      expect(repo.calls).toEqual(['purge', 'remove']);
    },
  );

  it('outro erro do banco (23505) sai como está, sem 409 e sem contar encartes', async () => {
    const { service, repo, guard, client } = await setup();
    const failure = queryFailed('23505');
    repo.removeError = failure;

    await expect(service.remove(client.id)).rejects.toBe(failure);
    expect(guard.countLiveOfClient).not.toHaveBeenCalled();
  });

  it('erro comum, que não é do banco, sai como está', async () => {
    const { service, repo, guard, client } = await setup();
    const failure = Object.assign(new Error('boom'), { code: '23503' });
    repo.removeError = failure;

    await expect(service.remove(client.id)).rejects.toBe(failure);
    expect(guard.countLiveOfClient).not.toHaveBeenCalled();
  });

  it('cliente inexistente: 404 CLIENT_NOT_FOUND e nada é expurgado', async () => {
    const { service, repo, guard } = await setup();

    const failure = await service.remove('nao-existe').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundException);
    expect((failure as NotFoundException).getResponse()).toEqual({
      code: 'CLIENT_NOT_FOUND',
      message: 'Cliente não encontrado',
    });
    expect(guard.purgeDeletedOfClient).not.toHaveBeenCalled();
    expect(repo.calls).toEqual([]);
  });
});
