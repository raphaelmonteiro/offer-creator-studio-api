import { chatResponse, installFakeOpenAi, sentTo } from '../../ai/utils/openai-chat.testutil';
import { CAROUSEL_OFFERS } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { validateScriptV2 } from '../domain/mc-script-v2';
import { McScript } from '../domain/mc-types';
import { McScriptProcessor } from './mc-script.processor';
import { newScriptProcessor } from './mc-script.processor.testutil';

/** Tarefa 6.6 — o step `script` de um projeto F2 usa o diretor F2 (mock e OpenAI). */
describe('McScriptProcessor — diretor F2 "ofertas em sequência" (tarefa 6.6)', () => {
  const env = { provider: process.env.MC_SCRIPT_PROVIDER };
  const configEnv: Record<string, string> = {};
  const project = {
    id: 'p1',
    userId: 'u1',
    kitId: 'k1',
    format: 'offer_carousel',
    pipelineVersion: MC_PIPELINE_V2,
    tier: 'economico',
    layoutPreset: 'character_right',
    briefing: 'Ofertas da semana',
    targetDurationS: 25,
    reservedCredits: 0,
    consumedCredits: 0,
    // ofertas congeladas na criação (ids estáveis, com preço anterior/badge/foto/catálogo)
    options: { musicEnabled: true, captionsEnabled: false, products: CAROUSEL_OFFERS.slice(0, 4) },
  };
  let harness: ReturnType<typeof newScriptProcessor>;
  let processor: McScriptProcessor;

  beforeEach(() => {
    for (const key of Object.keys(configEnv)) delete configEnv[key];
    harness = newScriptProcessor({ project, tradeName: 'Mercadão', config: configEnv });
    ({ processor } = harness);
  });

  afterEach(() => {
    if (env.provider === undefined) delete process.env.MC_SCRIPT_PROVIDER;
    else process.env.MC_SCRIPT_PROVIDER = env.provider;
  });

  const saved = (): McScript => harness.saved();

  it('mock: abertura + uma fala por oferta congelada (na ordem) + fechamento; preset e legendas do projeto', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'mock';
    await processor.process({ stepId: 'st' });
    const script = saved();
    expect(script.format).toBe('offer_carousel');
    expect(script.scenes).toHaveLength(6);
    expect(script.lines?.filter((l) => l.kind === 'offer').map((l) => l.offerRef)).toEqual(
      CAROUSEL_OFFERS.slice(0, 4).map((o) => o.id),
    );
    expect(script).toMatchObject({
      layoutPreset: 'character_right',
      captions: false,
      endcard: { storeName: 'Mercadão' },
    });
    expect(script.offers?.[1]).toMatchObject({
      id: 'of-cafe',
      originalPrice: '18,99',
      badge: '-18%',
    });
    expect(validateScriptV2(script, { format: 'offer_carousel' })).toEqual([]);
  });

  it('openai: json_schema com exatamente uma fala por oferta; preço com dígitos vira extenso; fala sem preço vira a determinística', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'openai';
    configEnv.OPENAI_API_KEY = 'sk-test';
    const create = installFakeOpenAi(processor);
    create.mockResolvedValue(
      chatResponse({
        content: JSON.stringify({
          opening: 'Chegou a hora das ofertas!',
          offerLines: [
            { offerIndex: 0, text: 'Arroz Branco Tipo 1 por R$ 24,90!' },
            { offerIndex: 1, text: 'Café Torrado por quinze reais e quarenta e nove centavos!' },
            { offerIndex: 2, text: 'Óleo de soja imperdível!' },
            { offerIndex: 3, text: 'Leite Integral por quatro reais e setenta e nove centavos!' },
          ],
          closing: 'Corre pro Mercadão!',
        }),
      }),
    );
    await processor.process({ stepId: 'st' });
    const body = sentTo(create).body as {
      response_format: {
        json_schema: { schema: { properties: { offerLines: { minItems: number } } } };
      };
      messages: Array<{ content: string }>;
    };
    expect(body.response_format.json_schema.schema.properties.offerLines.minItems).toBe(4);
    expect(body.messages[0].content).toContain('(fale: "vinte e quatro reais e noventa centavos")');
    const lines = saved().scenes.map((s) => s.dialogue);
    expect(lines).toEqual([
      'Chegou a hora das ofertas!',
      'Arroz Branco Tipo 1 por vinte e quatro reais e noventa centavos!',
      'Café Torrado por quinze reais e quarenta e nove centavos!',
      'Óleo de Soja por sete reais e noventa e nove centavos a unidade!',
      'Leite Integral por quatro reais e setenta e nove centavos!',
      'Corre pro Mercadão!',
    ]);
  });
});
