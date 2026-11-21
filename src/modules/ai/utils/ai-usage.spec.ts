import { AiUsageCollector } from './ai-usage';

describe('AiUsageCollector', () => {
  it('coletor sem chamada: zero tokens, custo 0 e nenhum modelo', () => {
    expect(new AiUsageCollector().snapshot()).toEqual({
      model: null,
      models: [],
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('modelo declarado sem chamada: traz o modelo, zero tokens e custo 0', () => {
    const collector = new AiUsageCollector();
    collector.declareModel('gpt-6-luna');
    expect(collector.snapshot()).toMatchObject({
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('soma as chamadas: tokens e custo pela tabela de preços', () => {
    const collector = new AiUsageCollector();
    collector.record('gpt-6-luna', { prompt_tokens: 1000, completion_tokens: 200 });
    collector.record('gpt-6-luna', { input_tokens: 2000, output_tokens: 400 });
    expect(collector.snapshot()).toEqual({
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
      calls: 2,
      inputTokens: 3000,
      outputTokens: 600,
      costUsd: 0.0006,
    });
  });

  it('entrada lida do cache paga a taxa de cache', () => {
    const collector = new AiUsageCollector();
    collector.record('gpt-6.1-terra', {
      prompt_tokens: 10_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 10_000 },
    });
    expect(collector.snapshot().costUsd).toBe(0.0005);
  });

  it('modelo sem preço na tabela: tokens somados e custo nulo, nunca zero', () => {
    const collector = new AiUsageCollector();
    collector.record('gpt-4o', { prompt_tokens: 1000, completion_tokens: 200 });
    expect(collector.snapshot()).toMatchObject({
      calls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: null,
    });
  });

  it('uma chamada sem preço torna nulo o custo da invocação inteira', () => {
    const collector = new AiUsageCollector();
    collector.record('gpt-6-luna', { prompt_tokens: 1000, completion_tokens: 200 });
    collector.record('gpt-4o', { prompt_tokens: 1000, completion_tokens: 200 });
    expect(collector.snapshot().costUsd).toBeNull();
    expect(collector.snapshot().models).toEqual(['gpt-6-luna', 'gpt-4o']);
  });

  it('chamada concluída sem usage na resposta: conta a chamada, não soma tokens e o custo fica nulo', () => {
    const collector = new AiUsageCollector();
    collector.record('gpt-6-luna', undefined);
    expect(collector.snapshot()).toMatchObject({
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    });
  });

  it('o snapshot é uma cópia: mudar o resultado não muda o coletor', () => {
    const collector = new AiUsageCollector();
    collector.declareModel('gpt-6-luna');
    collector.snapshot().models.push('outro');
    expect(collector.snapshot().models).toEqual(['gpt-6-luna']);
  });

  describe('track: chamada abortada ou em andamento (D-orq-1)', () => {
    const USAGE = { prompt_tokens: 1000, completion_tokens: 200 };

    it('resposta com usage: entra como as de record e o custo segue conhecido', async () => {
      const collector = new AiUsageCollector();

      await collector.track('gpt-6-luna', async () => ({ usage: USAGE }));

      expect(collector.snapshot()).toMatchObject({ calls: 1, inputTokens: 1000, costUsd: 0.0002 });
    });

    it('chamada ainda em andamento: o custo é nulo, mesmo com outra concluída, e volta a valer quando ela termina', async () => {
      const collector = new AiUsageCollector();
      await collector.track('gpt-6-luna', async () => ({ usage: USAGE }));
      let finish: (value: { usage: typeof USAGE }) => void = () => undefined;
      const pending = collector.track(
        'gpt-6-luna',
        () => new Promise<{ usage: typeof USAGE }>((resolve) => (finish = resolve)),
      );

      expect(collector.snapshot()).toMatchObject({ calls: 1, costUsd: null });

      finish({ usage: USAGE });
      await pending;
      expect(collector.snapshot()).toMatchObject({ calls: 2, costUsd: 0.0004 });
    });

    it('chamada abortada no meio: entra como chamada sem uso e o custo fica nulo, nunca a soma das que terminaram', async () => {
      const collector = new AiUsageCollector();
      await collector.track('gpt-6-luna', async () => ({ usage: USAGE }));

      await expect(
        collector.track(
          'gpt-6-luna',
          () => Promise.reject(new Error('aborted')),
          () => true,
        ),
      ).rejects.toThrow('aborted');

      expect(collector.snapshot()).toMatchObject({ calls: 2, inputTokens: 1000, costUsd: null });
    });

    it('erro de resposta do provedor (não abortada): não entra e o custo das concluídas segue conhecido', async () => {
      const collector = new AiUsageCollector();
      await collector.track('gpt-6-luna', async () => ({ usage: USAGE }));

      await expect(
        collector.track('gpt-6-luna', () => Promise.reject(new Error('503'))),
      ).rejects.toThrow('503');

      expect(collector.snapshot()).toMatchObject({ calls: 1, costUsd: 0.0002 });
    });
  });
});
