import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { McProjectStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McScriptProcessor } from './mc-script.processor';

describe('McScriptProcessor — estorno da mini-reserva na falha terminal (plano §6.7)', () => {
  const originalProvider = process.env.MC_SCRIPT_PROVIDER;

  const step = {
    id: 'step-1',
    projectId: 'proj-1',
    type: McStepType.SCRIPT,
    status: McStepStatus.QUEUED,
    attempts: 0,
  };
  const project = {
    id: 'proj-1',
    userId: 'u1',
    reservedCredits: 10,
    consumedCredits: 0,
    briefing: 'b',
    targetDurationS: 10,
    options: {
      musicEnabled: true,
      captionsEnabled: true,
      products: [{ name: 'Café Pilão', price: '12,90' }],
    },
  };

  let manager: { update: jest.Mock; insert: jest.Mock };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock; query: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let credits: { refundUnconsumed: jest.Mock };
  let processor: McScriptProcessor;

  beforeEach(() => {
    manager = { update: jest.fn().mockResolvedValue(undefined), insert: jest.fn() };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest
          .fn()
          .mockResolvedValue(entity === McStep ? step : entity === McProject ? project : null),
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
      // users.establishment.tradeName → cartela final (query crua, sem acoplar auth)
      query: jest.fn().mockResolvedValue([{ establishment: { tradeName: 'Mercado do Zé' } }]),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    credits = { refundUnconsumed: jest.fn().mockResolvedValue(10) };
    processor = new McScriptProcessor(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      commercials as unknown as CommercialsService,
      credits as unknown as CreditsService,
    );
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_SCRIPT_PROVIDER;
    else process.env.MC_SCRIPT_PROVIDER = originalProvider;
  });

  it('falha terminal do script → estorno TOTAL da mini-reserva na mesma transação', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'openai'; // sem OPENAI_API_KEY no teste → falha terminal
    await processor.process({ stepId: 'step-1' });

    expect(credits.refundUnconsumed).toHaveBeenCalledTimes(1);
    expect(credits.refundUnconsumed).toHaveBeenCalledWith(
      manager, // mesma transação do CAS de falha
      'u1',
      'proj-1', // projectId como ref do ledger (mesma ref usada na reserva)
      10, // reservado na criação
      0, // nada consumido → estorno total
    );
  });

  it('estorno só acontece para quem VENCE o CAS do projeto (idempotência de job duplicado)', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'openai';
    transitions.casTransition
      .mockResolvedValueOnce(true) // queued → running (step)
      .mockResolvedValueOnce(true) // running → failed (step)
      .mockResolvedValueOnce(false); // scripting → failed (projeto): outro venceu
    await processor.process({ stepId: 'step-1' });
    expect(credits.refundUnconsumed).not.toHaveBeenCalled();
  });

  it('sucesso do script (provider mock) não estorna nada', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'mock';
    await processor.process({ stepId: 'step-1' });
    expect(credits.refundUnconsumed).not.toHaveBeenCalled();
    // sanity: o caminho feliz gravou o roteiro no projeto
    expect(manager.update).toHaveBeenCalledWith(
      McProject,
      { id: 'proj-1' },
      expect.objectContaining({ script: expect.any(Object) }),
    );
  });

  describe('diretor MOCK multi-cena (contrato v1-B1)', () => {
    /** Roteiro gravado no projeto pelo caminho feliz. */
    function savedScript(): McScript {
      const call = manager.update.mock.calls.find(
        ([entity]) => entity === McProject,
      ) as unknown as [unknown, unknown, { script: McScript }];
      return call[2].script;
    }

    beforeEach(() => {
      process.env.MC_SCRIPT_PROVIDER = 'mock';
    });

    it('grava 3 cenas — 2 faladas + 1 muda — para o e2e multi-cena de custo zero', async () => {
      await processor.process({ stepId: 'step-1' });
      const script = savedScript();
      expect(script.version).toBe(2);
      expect(script.scenes).toHaveLength(3);
      expect(script.scenes.filter((s) => s.dialogue !== null)).toHaveLength(2);
      expect(script.scenes.filter((s) => s.dialogue === null)).toHaveLength(1);
      expect(script.scenes.every((s) => !!s.actionPromptEn)).toBe(true);
    });

    it('popula o selo com os produtos do projeto e a cartela com o estabelecimento', async () => {
      await processor.process({ stepId: 'step-1' });
      const script = savedScript();
      expect(script.seal?.products).toEqual([{ name: 'Café Pilão', price: '12,90' }]);
      expect(script.endcard).toEqual({ storeName: 'Mercado do Zé' });
    });

    it('usuário sem estabelecimento → roteiro sem cartela (nada quebra)', async () => {
      dataSource.query.mockResolvedValue([{ establishment: null }]);
      await processor.process({ stepId: 'step-1' });
      expect(savedScript().endcard).toBeUndefined();
    });

    it('falha ao ler o estabelecimento não derruba o roteiro', async () => {
      dataSource.query.mockRejectedValue(new Error('banco piscou'));
      await processor.process({ stepId: 'step-1' });
      expect(savedScript().scenes).toHaveLength(3);
      expect(savedScript().endcard).toBeUndefined();
    });

    it('o evento da transição leva a contagem de cenas (a UI mostra o storyboard)', async () => {
      await processor.process({ stepId: 'step-1' });
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          refKind: 'project',
          toStatus: McProjectStatus.STORYBOARD_REVIEW,
          detail: { sceneCount: 3 },
        }),
      );
    });
  });
});
