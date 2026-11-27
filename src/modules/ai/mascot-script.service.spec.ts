import { MascotScriptService } from './mascot-script.service';
import { logged } from './utils/ai-product-chat.testutil';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  sentTo,
  spyOnLogger,
} from './utils/openai-chat.testutil';

const FLYER_ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

function build(env: Record<string, string> = {}) {
  const document = { products: [{ name: 'Arroz 5kg', price: 19.9, unit: 'un' }] };
  const dataSource = {
    query: jest
      .fn()
      .mockResolvedValue([{ id: FLYER_ID, name: 'Encarte', document, clientName: 'Mercado' }]),
  };
  const service = new MascotScriptService(
    fakeConfig({ OPENAI_API_KEY: 'sk-teste', ...env }),
    dataSource as never,
  );
  return { service, create: installFakeOpenAi(service), logs: spyOnLogger(service) };
}

const answer = (script = 'Hoje tem arroz em oferta, venha conferir!') =>
  chatResponse({ content: JSON.stringify({ script }) });

const dto = (tone: 'animado' | 'institucional') => ({ flyerId: FLYER_ID, tone, maxSeconds: 30 });

describe('MascotScriptService (chat do roteiro do mascote)', () => {
  it('Roteiro do mascote animado em Luna: esforço none, temperature 0.7 e max_completion_tokens, sem max_tokens', async () => {
    const { service, create } = build();
    create.mockResolvedValueOnce(answer());

    const result = await service.createScript(dto('animado'));

    expect(result.source).toBe('ai');
    expect(result.script).toBe('Hoje tem arroz em oferta, venha conferir!');
    const { body, options } = sentTo(create);
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      reasoning_effort: 'none',
      temperature: 0.7,
      max_completion_tokens: 2400,
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(options).toEqual({ timeout: 30_000, maxRetries: 0 });
  });

  it('Tom institucional leva temperature 0.4', async () => {
    const { service, create } = build();
    create.mockResolvedValueOnce(answer());

    await service.createScript(dto('institucional'));

    expect(sentTo(create).body).toMatchObject({ reasoning_effort: 'none', temperature: 0.4 });
  });

  it('Roteiro de volta ao modelo de hoje: max_tokens 600 e temperature, sem esforço', async () => {
    const { service, create } = build({ OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini' });
    create.mockResolvedValueOnce(answer());

    await service.createScript(dto('animado'));

    const { body } = sentTo(create);
    expect(body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 600, temperature: 0.7 });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('Resposta cortada pelo teto: o log traz o aviso truncated e o roteiro automático assume', async () => {
    const { service, create, logs } = build();
    create.mockResolvedValueOnce(
      chatResponse({ content: '{"script": "Hoje', finishReason: 'length' }),
    );

    const result = await service.createScript(dto('animado'));

    expect(result.source).toBe('fallback');
    expect(logged(logs.warn, 'AI response invalid ')).toMatchObject({
      feature: 'mascot.script',
      model: 'gpt-6-luna',
      reason: 'truncated',
    });
  });
});
