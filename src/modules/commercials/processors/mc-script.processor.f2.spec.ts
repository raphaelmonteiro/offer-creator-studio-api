import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { CAROUSEL_OFFERS } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { validateScriptV2 } from '../domain/mc-script-v2';
import { McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McScriptProcessor } from './mc-script.processor';

/** Tarefa 6.6 — o step `script` de um projeto F2 usa o diretor F2 (mock e OpenAI). */
describe('McScriptProcessor — diretor F2 "ofertas em sequência" (tarefa 6.6)', () => {
  const env = {
    provider: process.env.MC_SCRIPT_PROVIDER,
    key: process.env.OPENAI_API_KEY,
  };
  const step = {
    id: 'st',
    projectId: 'p1',
    type: McStepType.SCRIPT,
    status: McStepStatus.QUEUED,
    attempts: 0,
  };
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
  let manager: { update: jest.Mock; insert: jest.Mock };
  let processor: McScriptProcessor;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    manager = { update: jest.fn().mockResolvedValue(undefined), insert: jest.fn() };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest
          .fn()
          .mockResolvedValue(
            entity === McStep
              ? step
              : entity === McProject
                ? project
                : entity === McCharacterKit
                  ? { id: 'k1', identityMode: 'generated' }
                  : null,
          ),
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
      query: jest.fn().mockResolvedValue([{ establishment: { tradeName: 'Mercadão' } }]),
    };
    processor = new McScriptProcessor(
      dataSource as unknown as DataSource,
      {
        casTransition: jest.fn().mockResolvedValue(true),
        notify: jest.fn().mockResolvedValue(undefined),
      } as unknown as TaskTransitionService,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
      { refundUnconsumed: jest.fn() } as unknown as CreditsService,
    );
  });

  afterEach(() => {
    fetchMock?.mockRestore();
    for (const [key, value] of [
      ['MC_SCRIPT_PROVIDER', env.provider],
      ['OPENAI_API_KEY', env.key],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const saved = (): McScript =>
    (
      manager.update.mock.calls.find(([entity]) => entity === McProject) as [
        unknown,
        unknown,
        { script: McScript },
      ]
    )[2].script;

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
    process.env.OPENAI_API_KEY = 'sk-test';
    let body: {
      response_format: {
        json_schema: { schema: { properties: { offerLines: { minItems: number } } } };
      };
      messages: Array<{ content: string }>;
    } | null = null;
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse((init as { body: string }).body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  opening: 'Chegou a hora das ofertas!',
                  offerLines: [
                    { offerIndex: 0, text: 'Arroz Branco Tipo 1 por R$ 24,90!' },
                    {
                      offerIndex: 1,
                      text: 'Café Torrado por quinze reais e quarenta e nove centavos!',
                    },
                    { offerIndex: 2, text: 'Óleo de soja imperdível!' },
                    {
                      offerIndex: 3,
                      text: 'Leite Integral por quatro reais e setenta e nove centavos!',
                    },
                  ],
                  closing: 'Corre pro Mercadão!',
                }),
              },
            },
          ],
        }),
      } as unknown as Response;
    });
    await processor.process({ stepId: 'st' });
    expect(body!.response_format.json_schema.schema.properties.offerLines.minItems).toBe(4);
    expect(body!.messages[0].content).toContain(
      '(fale: "vinte e quatro reais e noventa centavos")',
    );
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
