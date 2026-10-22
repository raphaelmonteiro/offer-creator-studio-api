import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { defaultPieceDocument, McPieceDocument } from '../domain/mc-piece';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { validateScriptV2 } from '../domain/mc-script-v2';
import { McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McScriptProcessor } from './mc-script.processor';

function snapshot(): McPieceDocument {
  const doc = defaultPieceDocument('9:16');
  const products = doc.blocks[0] as Extract<
    McPieceDocument['blocks'][number],
    { type: 'products' }
  >;
  products.items = [
    {
      id: 'it-picanha',
      name: 'Picanha bovina',
      price: '59,90',
      unit: 'kg',
      imageUrl: '/uploads/g/1.png',
      spoken: true,
    },
    {
      id: 'it-cerveja',
      name: 'Cerveja lata 350 ml',
      price: '3,49',
      unit: 'un',
      imageUrl: '/uploads/g/2.png',
      spoken: false,
    },
    {
      id: 'it-arroz',
      name: 'Arroz tipo 1 5 kg',
      price: '24,90',
      imageUrl: '/uploads/g/3.png',
      spoken: true,
    },
    {
      id: 'it-refri',
      name: 'Refrigerante 2 L',
      price: '7,99',
      imageUrl: '/uploads/g/4.png',
      spoken: true,
    },
  ];
  const footer = doc.blocks[1] as Extract<McPieceDocument['blocks'][number], { type: 'footer' }>;
  footer.validity = { from: '2026-04-14', to: '2026-04-16' };
  doc.blocks.push({
    id: 'character',
    type: 'character',
    rect: { x: 0.58, y: 0.6, w: 0.37, h: 0.28 },
    zIndex: 4,
    kitId: 'k1',
    mode: 'in_piece',
    panel: { shape: 'card', color: '#FFFFFF' },
  });
  return doc;
}

/** Tarefa 5.2 — o step `script` de um projeto `offer_piece` usa o diretor do F2 sobre a peça congelada. */
describe('McScriptProcessor — diretor da peça de ofertas (tarefa 5.2)', () => {
  const env = { provider: process.env.MC_SCRIPT_PROVIDER, key: process.env.OPENAI_API_KEY };
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
    format: 'offer_piece',
    pipelineVersion: MC_PIPELINE_V2,
    tier: 'economico',
    aspectRatio: '9:16',
    briefing: 'Peça "Ofertas" com as ofertas',
    targetDurationS: 25,
    reservedCredits: 0,
    consumedCredits: 0,
    // os produtos do projeto têm ids próprios: o roteiro da peça usa os ids dos ITENS do snapshot
    options: {
      musicEnabled: false,
      captionsEnabled: false,
      products: [
        { id: 'x1', name: 'Picanha bovina', price: '59,90' },
        { id: 'x2', name: 'Arroz tipo 1 5 kg', price: '24,90' },
        { id: 'x3', name: 'Refrigerante 2 L', price: '7,99' },
      ],
    },
    pieceId: 'piece-1',
    pieceSnapshot: snapshot(),
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
      query: jest.fn().mockResolvedValue([{ establishment: { tradeName: 'Mercado Bom Preço' } }]),
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

  it('mock: abertura + uma fala por item FALADO (ids dos itens, na ordem da peça) + fechamento com a validade; janela e painel da peça', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'mock';
    await processor.process({ stepId: 'st' });
    const script = saved();
    expect(script.format).toBe('offer_piece');
    expect(script.scenes).toHaveLength(5);
    expect(script.offers?.map((o) => o.id)).toEqual(['it-picanha', 'it-arroz', 'it-refri']);
    expect(script.lines?.filter((l) => l.kind === 'offer').map((l) => l.offerRef)).toEqual([
      'it-picanha',
      'it-arroz',
      'it-refri',
    ]);
    expect(script.scenes[1].dialogue).toContain('cinquenta e nove reais e noventa centavos');
    expect(script.scenes[4].dialogue).toContain('até 16/04');
    expect(script).toMatchObject({
      window: { x: 0.58, y: 0.6, w: 0.37, h: 0.28 },
      logoFace: false,
      talkBackgroundColor: '#FFFFFF',
      captions: false,
      endcard: { storeName: 'Mercado Bom Preço' },
    });
    expect(validateScriptV2(script, { format: 'offer_piece' })).toEqual([]);
  });

  it('openai: o prompt leva a validade para o fechamento e o roteiro sai como peça', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    let body: { messages: Array<{ content: string }> } | null = null;
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
                  opening: 'Olá! Ofertas de hoje no Mercado Bom Preço!',
                  offerLines: [
                    {
                      offerIndex: 0,
                      text: 'Picanha bovina por cinquenta e nove reais e noventa centavos o quilo!',
                    },
                    {
                      offerIndex: 1,
                      text: 'Arroz tipo 1 por vinte e quatro reais e noventa centavos!',
                    },
                    {
                      offerIndex: 2,
                      text: 'Refrigerante por sete reais e noventa e nove centavos!',
                    },
                  ],
                  closing: 'Válido só até 16/04. Corre pra cá!',
                }),
              },
            },
          ],
        }),
      } as Response;
    });
    await processor.process({ stepId: 'st' });
    expect(body!.messages[0].content).toContain('valem até 16/04');
    const script = saved();
    expect(script.format).toBe('offer_piece');
    expect(script.scenes.map((s) => s.dialogue)).toEqual([
      'Olá! Ofertas de hoje no Mercado Bom Preço!',
      'Picanha bovina por cinquenta e nove reais e noventa centavos o quilo!',
      'Arroz tipo 1 por vinte e quatro reais e noventa centavos!',
      'Refrigerante por sete reais e noventa e nove centavos!',
      'Válido só até 16/04. Corre pra cá!',
    ]);
    expect(validateScriptV2(script, { format: 'offer_piece' })).toEqual([]);
  });
});
