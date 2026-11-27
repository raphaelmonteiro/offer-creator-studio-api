import { DataSource } from 'typeorm';
import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  sentTo,
  spyOnLogger,
} from '../../ai/utils/openai-chat.testutil';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { KitCanonicalDesc } from '../domain/kit-prompts';
import { McKitStatus } from '../domain/mc-state-machines';
import { McKitViewService } from '../services/mc-kit-view.service';
import { McKitProcessor } from './mc-kit.processor';

/**
 * Descrição canônica do kit (change 42, task 1.11): modelo de MC_KIT_VISION_MODEL, parâmetros pela família do
 * modelo, prazo de hoje e custo pelo modelo efetivo da resposta. Cliente simulado, nenhuma chamada paga.
 */
const DESC = {
  traits: ['capybara'],
  accessories: [],
  colors: ['#7B4A2D'],
  style: '3D cartoon',
  doNots: ['never change the apron color'],
  pt: { traits: ['capivara'], accessories: [], style: '3D', doNots: ['x'] },
} satisfies KitCanonicalDesc;

const KIT = { id: 'kit-1', userId: 'u1', mascotId: 'mascot-1', status: McKitStatus.GENERATING };
const IMAGE = Buffer.from('imagem-do-mascote');

describe('McKitProcessor — descrição canônica (42, 1.11)', () => {
  const originalProvider = process.env.MC_KIT_PROVIDER;
  const config: Record<string, string> = {};
  let processor: McKitProcessor;
  let create: jest.Mock;
  let appendEvent: jest.Mock;
  let kitRow: Record<string, unknown> | null;
  let transaction: jest.Mock;
  let logs: ReturnType<typeof spyOnLogger>;

  beforeEach(() => {
    for (const key of Object.keys(config)) delete config[key];
    config.OPENAI_API_KEY = 'sk-test';
    process.env.MC_KIT_PROVIDER = 'gemini';
    kitRow = null;
    appendEvent = jest.fn().mockResolvedValue(undefined);
    transaction = jest.fn((cb: (m: unknown) => Promise<unknown>) => cb({ increment: jest.fn() }));
    const dataSource = {
      transaction,
      getRepository: jest.fn(() => ({ findOneBy: jest.fn(() => Promise.resolve(kitRow)) })),
    };
    processor = new McKitProcessor(
      dataSource as unknown as DataSource,
      {} as TaskTransitionService,
      { appendEvent } as unknown as CommercialsService,
      {} as GeminiImageProvider,
      { findOne: jest.fn().mockResolvedValue({ name: 'Capi' }) } as unknown as MascotsService,
      fakeConfig(config),
      {} as McKitViewService,
    );
    create = installFakeOpenAi(processor);
    logs = spyOnLogger(processor);
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_KIT_PROVIDER;
    else process.env.MC_KIT_PROVIDER = originalProvider;
  });

  /** A chamada da descrição, como o fluxo do kit a faz. */
  function describeMascot(): Promise<KitCanonicalDesc> {
    return (
      processor as unknown as {
        generateCanonicalDesc: (
          image: Buffer,
          kit: object,
          context: object,
        ) => Promise<KitCanonicalDesc>;
      }
    ).generateCanonicalDesc(IMAGE, KIT, { generationKey: 'job-1' });
  }

  const costDetail = () => appendEvent.mock.calls[0][1].detail as Record<string, unknown>;

  it('Descrição canônica em Terra: esforço low, teto da família nova, o mesmo json_schema, sem temperature e com o prazo de hoje', async () => {
    create.mockResolvedValue(
      chatResponse({
        content: JSON.stringify(DESC),
        usage: { prompt_tokens: 1500, completion_tokens: 600 },
      }),
    );
    await describeMascot();

    expect(create).toHaveBeenCalledTimes(1);
    const { body, options } = sentTo(create);
    expect(body).toMatchObject({
      model: 'gpt-6.1-terra',
      reasoning_effort: 'low',
      max_completion_tokens: 4096,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'kit_canonical_desc_v2', strict: true },
      },
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(options).toEqual({ maxRetries: 0, timeout: 60_000 });
  });

  it('Descrição canônica em Terra: a linha de custo usa o modelo efetivo da resposta (snapshot datado casa pelo prefixo)', async () => {
    create.mockResolvedValue({
      ...chatResponse({
        content: JSON.stringify(DESC),
        usage: { prompt_tokens: 1500, completion_tokens: 600 },
      }),
      model: 'gpt-6.1-terra-2026-10-01',
    });
    await describeMascot();

    // 1.500 × 1,00/1M + 600 × 5,00/1M
    expect(costDetail()).toMatchObject({
      call: 'canonical_desc',
      model: 'gpt-6.1-terra-2026-10-01',
      requestedModel: 'gpt-6.1-terra',
      usage: { inputTokens: 1500, outputTokens: 600 },
    });
    expect(costDetail().costUsd).toBeCloseTo(0.0045, 8);
    expect(logs.lines().find((line) => line.startsWith('AI operation finished'))).toContain(
      '"feature":"commercials.kit-canonical-desc"',
    );
  });

  it('Modelo fora da tabela: a linha traz os tokens e costUsd nulo', async () => {
    config.MC_KIT_VISION_MODEL = 'gpt-5-mini';
    create.mockResolvedValue({
      ...chatResponse({
        content: JSON.stringify(DESC),
        usage: { prompt_tokens: 1000, completion_tokens: 400 },
      }),
      model: 'gpt-5-mini-2026-01-01',
    });
    await describeMascot();

    expect(costDetail()).toMatchObject({
      model: 'gpt-5-mini-2026-01-01',
      requestedModel: 'gpt-5-mini',
      usage: { inputTokens: 1000, outputTokens: 400 },
      costUsd: null,
    });
  });

  it('volta a gpt-4o: o corpo de hoje (max_tokens 600, sem temperature, sem esforço) e custo pelo preço de hoje', async () => {
    config.MC_KIT_VISION_MODEL = 'gpt-4o';
    create.mockResolvedValue({
      ...chatResponse({
        content: JSON.stringify(DESC),
        usage: { prompt_tokens: 1200, completion_tokens: 500 },
      }),
      model: 'gpt-4o-2024-08-06',
    });
    await describeMascot();

    const { body, options } = sentTo(create);
    expect(body).toMatchObject({ model: 'gpt-4o', max_tokens: 600 });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(options).toEqual({ maxRetries: 0, timeout: 60_000 });
    // 1.200 × 2,5/1M + 500 × 10/1M
    expect(costDetail().costUsd).toBeCloseTo(0.008, 8);
  });

  it('não herda OPENAI_TEXT_MODEL, e variável vazia ou só com espaços vale o padrão', async () => {
    config.OPENAI_TEXT_MODEL = 'gpt-4o';
    config.MC_KIT_VISION_MODEL = '  ';
    create.mockResolvedValue(chatResponse({ content: JSON.stringify(DESC) }));
    await describeMascot();
    expect(sentTo(create).body.model).toBe('gpt-6.1-terra');

    config.MC_KIT_VISION_MODEL = '';
    await describeMascot();
    expect(sentTo(create, 1).body.model).toBe('gpt-6.1-terra');
  });

  it('Kit aprovado antes da change: o kit fora de generating não chama a OpenAI nem muda a descrição', async () => {
    kitRow = { ...KIT, status: McKitStatus.APPROVED, canonicalDesc: JSON.stringify(DESC) };
    await processor.process({ kitId: 'kit-1' }, 'job-2');

    expect(create).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(kitRow.canonicalDesc).toBe(JSON.stringify(DESC));
  });
});
