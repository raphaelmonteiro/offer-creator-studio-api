import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { CommercialsService } from '../commercials.service';
import { McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McScriptProcessor } from './mc-script.processor';

/** Apoio dos testes do `McScriptProcessor`: o processador com banco, transições, créditos e configuração simulados. */
export const SCRIPT_STEP_ID = 'st';

const STEP = {
  id: SCRIPT_STEP_ID,
  projectId: 'p1',
  type: McStepType.SCRIPT,
  status: McStepStatus.QUEUED,
  attempts: 0,
};

export interface ScriptProcessorOptions {
  /** O projeto que o banco devolve (a mesma referência: o teste pode mudá-lo depois de montar o processador). */
  project: Record<string, unknown>;
  /** Kit que o banco devolve; ausente, um kit gerado. */
  kit?: Record<string, unknown>;
  /** Outras entidades (as imagens do kit, por exemplo); `undefined` cai no padrão. */
  lookup?: (entity: unknown, where: { id: string }) => unknown;
  /** Nome do estabelecimento do usuário (`users.establishment.tradeName`). */
  tradeName?: string;
  /** Configuração do `ConfigService` simulado (a mesma referência: o teste pode mudá-la depois). */
  config?: Record<string, string>;
}

export function newScriptProcessor(options: ScriptProcessorOptions) {
  const kit = options.kit ?? { id: 'k1', identityMode: 'generated' };
  const manager = { update: jest.fn().mockResolvedValue(undefined), insert: jest.fn() };
  const dataSource = {
    getRepository: jest.fn((entity: unknown) => ({
      findOneBy: jest.fn((where: { id: string }) => {
        const other = options.lookup?.(entity, where);
        if (other !== undefined) return Promise.resolve(other);
        if (entity === McStep) return Promise.resolve(STEP);
        if (entity === McProject) return Promise.resolve(options.project);
        if (entity === McCharacterKit) return Promise.resolve(kit);
        return Promise.resolve(null);
      }),
    })),
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager as unknown as EntityManager),
    ),
    // users.establishment.tradeName → cartela final (query crua, sem acoplar auth)
    query: jest
      .fn()
      .mockResolvedValue([{ establishment: { tradeName: options.tradeName ?? 'Mercadão' } }]),
  };
  const transitions = {
    casTransition: jest.fn().mockResolvedValue(true),
    notify: jest.fn().mockResolvedValue(undefined),
  };
  const commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
  const credits = { refundUnconsumed: jest.fn().mockResolvedValue(10) };
  const processor = new McScriptProcessor(
    dataSource as unknown as DataSource,
    transitions as unknown as TaskTransitionService,
    commercials as unknown as CommercialsService,
    credits as unknown as CreditsService,
    fakeConfig(options.config ?? {}),
  );
  /** Roteiro que o caminho feliz gravou no projeto. */
  const saved = (): McScript =>
    (
      manager.update.mock.calls.find(([entity]) => entity === McProject) as unknown as [
        unknown,
        unknown,
        { script: McScript },
      ]
    )[2].script;
  return { processor, manager, dataSource, transitions, commercials, credits, saved };
}
