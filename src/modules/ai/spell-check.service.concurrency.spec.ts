import { openAiError } from './utils/openai-chat.testutil';
import { answer, build, products } from './spell-check.service.testutil';

describe('SpellCheckService, teto de chamadas em paralelo', () => {
  function trackPeak(create: jest.Mock) {
    const state = { running: 0, peak: 0, calls: 0 };
    create.mockImplementation(async () => {
      state.calls += 1;
      state.running += 1;
      state.peak = Math.max(state.peak, state.running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      state.running -= 1;
      return answer();
    });
    return state;
  }

  it('78 produtos só com nome: 8 lotes e nunca mais de 4 em andamento', async () => {
    const { service, create } = build();
    const state = trackPeak(create);

    await service.spellCheck(products(78));

    expect(state.calls).toBe(8);
    expect(state.peak).toBe(4);
  });

  it('as correções dos 8 lotes voltam, na ordem dos lotes', async () => {
    const { service, create } = build();
    create.mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
      const first = /"productId": "p-(\d+)"/.exec(body.messages[1].content)![1];
      return answer({
        corrections: [{ productId: `p-${first}`, field: 'name', original: 'a', suggestion: 'b' }],
      });
    });

    const result = await service.spellCheck(products(78));

    expect(result.corrections.map((c) => c.productId)).toEqual([
      'p-0',
      'p-10',
      'p-20',
      'p-30',
      'p-40',
      'p-50',
      'p-60',
      'p-70',
    ]);
  });

  it('revisão pequena: uma só chamada', async () => {
    const { service, create } = build();
    const state = trackPeak(create);
    await service.spellCheck(products(3));
    expect(state.calls).toBe(1);
    expect(state.peak).toBe(1);
  });

  it('AI_SPELLCHECK_CONCURRENCY=8: os 8 lotes ao mesmo tempo, nunca mais de 8', async () => {
    const { service, create } = build({ AI_SPELLCHECK_CONCURRENCY: '8' });
    const state = trackPeak(create);
    await service.spellCheck(products(78));
    expect(state.calls).toBe(8);
    expect(state.peak).toBe(8);
  });

  it.each(['0', 'abc', '-3', ''])('valor inválido (%p) no teto vale 4', async (invalid) => {
    const { service, create } = build({ AI_SPELLCHECK_CONCURRENCY: invalid });
    const state = trackPeak(create);
    await service.spellCheck(products(78));
    expect(state.peak).toBe(4);
  });

  it('duas revisões ao mesmo tempo: cada uma mantém no máximo 4 em andamento', async () => {
    const { service, create } = build();
    const running: Record<string, number> = { A: 0, B: 0 };
    const peak: Record<string, number> = { A: 0, B: 0 };
    create.mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
      const review = body.messages[1].content.includes('"productId": "A-') ? 'A' : 'B';
      running[review] += 1;
      peak[review] = Math.max(peak[review], running[review]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running[review] -= 1;
      return answer();
    });

    await Promise.all([
      service.spellCheck(products(78, 'A')),
      service.spellCheck(products(78, 'B')),
    ]);

    expect(peak).toEqual({ A: 4, B: 4 });
    expect(create).toHaveBeenCalledTimes(16);
  });

  it('um lote falha no sexto início: a revisão rejeita com o erro do provedor', async () => {
    const { service, create } = build();
    let call = 0;
    create.mockImplementation(async () => {
      call += 1;
      if (call === 6) throw openAiError(500, 'falha do lote 6');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return answer();
    });

    await expect(service.spellCheck(products(78))).rejects.toThrow('falha do lote 6');
  });

  it('429 no lote 1 com os lotes 2 a 4 em andamento: 4 chamadas e os lotes 5 a 8 nunca são enviados', async () => {
    const { service, create } = build();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    create
      .mockRejectedValueOnce(openAiError(429, 'limite de uso', 'rate_limit_exceeded'))
      .mockImplementation(async () => {
        await held;
        return answer();
      });

    await expect(service.spellCheck(products(78))).rejects.toThrow('limite de uso');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(create).toHaveBeenCalledTimes(4);
  });
});
