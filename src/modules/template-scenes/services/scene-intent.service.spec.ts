import { ConfigService } from '@nestjs/config';
import { SceneIntentClient } from '../providers/scene-intent-client';
import { SceneIntentService } from './scene-intent.service';

const CONTEXT = { marked: false, layers: [{ name: 'Logo 1', kind: 'logo' }] };
const intentJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: 'global_adjust',
    zone: null,
    object: null,
    subject: null,
    imagePrompt: 'imagem mais quente',
    relativePlace: false,
    layer: null,
    text: null,
    ...extra,
  });

const build = (client: SceneIntentClient, env: Record<string, string> = {}) =>
  new SceneIntentService(new ConfigService(env), client);
const input = (message = 'deixa tudo mais quente') => ({
  message,
  context: CONTEXT,
  correlationId: 'corr-1',
});
const ok = (text: string, usage: object | null = { prompt_tokens: 1000, completion_tokens: 300 }) =>
  jest.fn().mockResolvedValue({ text, usage, requestId: 'req_i', latencyMs: 700 });

describe('SceneIntentService', () => {
  afterEach(() => jest.useRealTimers());

  it('sucesso: devolve a intenção, o custo pelo preço do modelo e a latência', async () => {
    const classify = ok(intentJson());

    const result = await build({ classify }).classify(input());

    expect(result).toMatchObject({
      status: 'ok',
      intent: { action: 'global_adjust' },
      metrics: {
        model: 'gpt-6-luna',
        status: 'ok',
        costUsd: 0.00025,
        latencyMs: 700,
        requestId: 'req_i',
      },
    });
    expect(classify).toHaveBeenCalledTimes(1);
    const sent = classify.mock.calls[0][0];
    expect(sent).toMatchObject({
      model: 'gpt-6-luna',
      timeoutMs: 8000,
      correlationId: 'corr-1',
      message: 'deixa tudo mais quente',
      marked: false,
    });
    expect(sent.system).toContain('camadas: Logo 1 (logo)');
    expect(sent.user).toContain('deixa tudo mais quente');
    expect(JSON.stringify(sent)).not.toContain('image_url');
  });

  it('usa o modelo e o tempo configurados', async () => {
    const classify = ok(intentJson());
    const result = await build(
      { classify },
      { TEMPLATE_SCENE_INTENT_MODEL: 'outro', TEMPLATE_SCENE_INTENT_TIMEOUT_MS: '3000' },
    ).classify(input());
    expect(classify.mock.calls[0][0]).toMatchObject({ model: 'outro', timeoutMs: 3000 });
    expect(result.metrics).toMatchObject({ model: 'outro', costUsd: null });
  });

  it('JSON inválido: status invalid, e o custo cobrado da chamada fica', async () => {
    const result = await build({ classify: ok('não é json') }).classify(input());
    expect(result).toMatchObject({
      status: 'invalid',
      metrics: { status: 'invalid', costUsd: 0.00025 },
    });
    expect(result).not.toHaveProperty('intent');
  });

  it('ação fora da lista e texto exato fora da mensagem: status invalid', async () => {
    const outside = await build({ classify: ok(intentJson({ action: 'apagar' })) }).classify(
      input(),
    );
    expect(outside.status).toBe('invalid');
    const text = intentJson({ action: 'set_text', text: { value: 'Natal', placement: 'none' } });
    const literal = await build({ classify: ok(text) }).classify(input('escreve "Páscoa"'));
    expect(literal.status).toBe('invalid');
  });

  it('erro do cliente: status error, sem custo conhecido', async () => {
    const classify = jest.fn().mockRejectedValue(new Error('429'));
    const result = await build({ classify }).classify(input());
    expect(result).toMatchObject({ status: 'error', metrics: { status: 'error', costUsd: null } });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('tempo esgotado: status timeout, sem esperar a resposta', async () => {
    jest.useFakeTimers();
    const classify = jest.fn().mockReturnValue(new Promise(() => undefined));
    const pending = build({ classify }, { TEMPLATE_SCENE_INTENT_TIMEOUT_MS: '8000' }).classify(
      input(),
    );
    await jest.advanceTimersByTimeAsync(8001);
    const result = await pending;
    expect(result).toMatchObject({
      status: 'timeout',
      metrics: { status: 'timeout', costUsd: null },
    });
  });

  it('sem usage na resposta o custo fica nulo', async () => {
    const result = await build({ classify: ok(intentJson(), null) }).classify(input());
    expect(result.metrics.costUsd).toBeNull();
  });
});
