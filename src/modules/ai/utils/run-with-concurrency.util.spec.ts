import { runWithConcurrency } from './run-with-concurrency.util';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

describe('runWithConcurrency', () => {
  it('nunca passa do limite e devolve os resultados na ordem dos itens', async () => {
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    const results = await runWithConcurrency(items, 4, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5 + (item % 3)));
      running -= 1;
      return item * 10;
    });
    expect(peak).toBe(4);
    expect(results).toEqual(items.map((i) => i * 10));
  });

  it('com limite maior que os itens, roda todos ao mesmo tempo e nunca mais que os itens', async () => {
    let running = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3], 8, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });
    expect(peak).toBe(3);
  });

  it('lista vazia devolve lista vazia sem chamar o worker', async () => {
    const worker = jest.fn();
    expect(await runWithConcurrency([], 4, worker)).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('limite inválido (0 ou negativo) roda um de cada vez', async () => {
    let running = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3], 0, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
    });
    expect(peak).toBe(1);
  });

  it('na primeira falha rejeita com o erro e não inicia os itens que faltam', async () => {
    const gate = deferred();
    const started: number[] = [];
    const run = runWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      if (item === 0) throw new Error('lote 0 falhou');
      await gate.promise;
      return item;
    });
    await expect(run).rejects.toThrow('lote 0 falhou');
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual([0, 1]);
  });
});
