/**
 * O `DataSource` simulado dos unitários de serviço (só testes): `transaction` entrega o `manager` ao trabalho, com ou sem o
 * nível de isolamento na frente (`transaction(work)` e `transaction('REPEATABLE READ', work)`), e `extra` acrescenta o que
 * o teste precisa do resto do `DataSource` (por exemplo `query`).
 */
export function fakeDataSource<T extends object = Record<string, never>>(
  manager: unknown,
  extra?: T,
): { transaction: jest.Mock } & T {
  return {
    transaction: jest.fn((...args: unknown[]) =>
      (args[args.length - 1] as (m: unknown) => unknown)(manager),
    ),
    ...extra,
  } as { transaction: jest.Mock } & T;
}
