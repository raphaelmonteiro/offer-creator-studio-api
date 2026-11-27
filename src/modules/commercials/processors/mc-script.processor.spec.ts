import { McProjectStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScript } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McScriptProcessor } from './mc-script.processor';
import { newScriptProcessor } from './mc-script.processor.testutil';

describe('McScriptProcessor — estorno da mini-reserva na falha terminal (plano §6.7)', () => {
  const originalProvider = process.env.MC_SCRIPT_PROVIDER;

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

  let manager: ReturnType<typeof newScriptProcessor>['manager'];
  let dataSource: ReturnType<typeof newScriptProcessor>['dataSource'];
  let transitions: ReturnType<typeof newScriptProcessor>['transitions'];
  let commercials: ReturnType<typeof newScriptProcessor>['commercials'];
  let credits: ReturnType<typeof newScriptProcessor>['credits'];
  let processor: McScriptProcessor;

  beforeEach(() => {
    // sem OPENAI_API_KEY na configuração (nem a do ambiente de quem roda a suíte)
    ({ processor, manager, dataSource, transitions, commercials, credits } = newScriptProcessor({
      project,
      tradeName: 'Mercado do Zé',
    }));
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_SCRIPT_PROVIDER;
    else process.env.MC_SCRIPT_PROVIDER = originalProvider;
  });

  it('falha terminal do script → estorno TOTAL da mini-reserva na mesma transação', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'openai'; // sem chave na configuração → falha terminal
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

  it('falha terminal do roteiro grava o texto pt-BR do catálogo no projeto, sem a mensagem crua', async () => {
    process.env.MC_SCRIPT_PROVIDER = 'openai'; // sem chave na configuração → falha terminal
    await processor.process({ stepId: 'step-1' });

    const stepPatch = transitions.casTransition.mock.calls.find(
      (call) => call[1] === McStep && call[4] === McStepStatus.FAILED,
    )?.[5] as { errorMessage: string; errorCode: string };
    const projectPatch = transitions.casTransition.mock.calls.find(
      (call) => call[1] === McProject && call[4] === McProjectStatus.FAILED,
    )?.[5] as { errorMessage: string; errorCode: string };
    expect(projectPatch.errorCode).toBe('script_failed');
    expect(projectPatch.errorMessage).toBe(
      'Não foi possível criar o roteiro do vídeo. Crie o vídeo de novo.',
    );
    // a mensagem crua do modelo/provider segue só no step (diagnóstico do administrador)
    expect(stepPatch.errorMessage).not.toBe(projectPatch.errorMessage);
    expect(stepPatch.errorMessage.length).toBeGreaterThan(0);
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
