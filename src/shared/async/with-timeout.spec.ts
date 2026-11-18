import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('devolve o resultado quando a chamada termina antes do prazo, sem deixar timer pendente', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
    expect(jest.getTimerCount()).toBe(0);
  });

  it("devolve 'timeout' quando o prazo passa antes da chamada", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('tarde'), 5000));
    const pending = withTimeout(slow, 1000);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe('timeout');
  });

  it('a rejeição da chamada antes do prazo sai como erro, e depois do prazo não vira rejeição solta', async () => {
    await expect(withTimeout(Promise.reject(new Error('falhou')), 1000)).rejects.toThrow('falhou');
    const late = new Promise<string>((_resolve, reject) =>
      setTimeout(() => reject(new Error('tarde')), 2000),
    );
    const pending = withTimeout(late, 1000);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe('timeout');
    await jest.advanceTimersByTimeAsync(2000);
  });
});
