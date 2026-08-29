import { UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { computeSceneStepHashes } from '../domain/mc-step-hashes';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McScript } from '../domain/mc-types';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';
import { McProjectActionsService } from './mc-project-actions.service';

type Row = Record<string, unknown> & { id: string };

const SCRIPT: McScript = {
  version: 2,
  scenes: [
    {
      idx: 0,
      actionPrompt: 'Mascote acena no corredor',
      actionPromptEn: 'The mascot waves in the aisle',
      dialogue: 'Bem-vindo às ofertas!',
      durationS: 6,
    },
    {
      idx: 1,
      actionPrompt: 'Mascote mostra o produto',
      actionPromptEn: 'The mascot shows the product',
      dialogue: null,
      durationS: 5,
    },
  ],
  seal: { products: [{ name: 'Café', price: '12,90' }] },
  endcard: { storeName: 'Mercado do Zé' },
};

describe('McProjectActionsService — duplicar em outro formato (plano §7.2)', () => {
  const userId = 'u1';
  let source: Row;
  let kit: Row;
  let saved: Array<Record<string, unknown>>;
  let manager: { create: jest.Mock; save: jest.Mock };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let credits: { reserve: jest.Mock; refundUnconsumed: jest.Mock };
  let projectCount: jest.Mock;
  let service: McProjectActionsService;

  beforeEach(() => {
    source = {
      id: 'p1',
      userId,
      kitId: 'kit-1',
      title: 'Ofertas da semana',
      briefing: 'briefing original',
      status: McProjectStatus.SUCCEEDED,
      script: JSON.parse(JSON.stringify(SCRIPT)) as McScript,
      aspectRatio: '9:16',
      targetDurationS: 15,
      options: { musicEnabled: false, captionsEnabled: true, products: [] },
      moderation: { flagged: false },
      reservedCredits: 160,
      consumedCredits: 160,
    };
    kit = { id: 'kit-1', userId, status: McKitStatus.APPROVED, version: 1, voiceId: 'v1' };
    saved = [];
    manager = {
      create: jest.fn((_e: unknown, obj: Record<string, unknown>) => ({ ...obj })),
      save: jest.fn((obj: Record<string, unknown>) => {
        const row = { id: 'p2', ...obj };
        saved.push(row);
        return Promise.resolve(row);
      }),
    };
    projectCount = jest.fn().mockResolvedValue(0);
    dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McProject) return Promise.resolve(source);
          if (entity === McCharacterKit) return Promise.resolve(kit);
          return Promise.resolve(null);
        }),
        findOneByOrFail: jest.fn(() => Promise.resolve(saved[0] ?? source)),
        count: projectCount,
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    credits = {
      reserve: jest.fn().mockResolvedValue(undefined),
      refundUnconsumed: jest.fn().mockResolvedValue(0),
    };
    service = new McProjectActionsService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      { get: jest.fn().mockResolvedValue(null) } as unknown as SystemSettingsService,
      credits as unknown as CreditsService,
      { moderate: jest.fn() } as unknown as ModerationProvider,
      commercials as unknown as CommercialsService,
      {} as unknown as McMaterializerService,
      {} as unknown as McPipelineService,
    );
  });

  it('cria projeto NOVO em storyboard_review, mesmo kit, no formato pedido', async () => {
    await service.duplicateProject(userId, 'p1', { aspectRatio: '1:1' });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      userId,
      kitId: 'kit-1',
      status: McProjectStatus.STORYBOARD_REVIEW,
      aspectRatio: '1:1',
      briefing: 'briefing original',
      targetDurationS: 15,
    });
  });

  it('copia o roteiro em PROFUNDIDADE — editar a cópia não toca no original', async () => {
    await service.duplicateProject(userId, 'p1', {});
    const copy = saved[0] as { script: McScript };

    expect(copy.script).toEqual(SCRIPT);
    expect(copy.script).not.toBe(source.script);
    expect(copy.script.scenes[0]).not.toBe((source.script as McScript).scenes[0]);

    copy.script.scenes[0].dialogue = 'outra fala';
    copy.script.seal!.products![0].price = '99,90';
    expect((source.script as McScript).scenes[0].dialogue).toBe('Bem-vindo às ofertas!');
    expect((source.script as McScript).seal!.products![0].price).toBe('12,90');
  });

  it('sem aspectRatio no body, herda o formato da origem', async () => {
    await service.duplicateProject(userId, 'p1', {});
    expect(saved[0]).toMatchObject({ aspectRatio: '9:16' });
  });

  it('nasce SEM steps e SEM reserva de créditos (quem gasta é o approve)', async () => {
    await service.duplicateProject(userId, 'p1', { aspectRatio: '16:9' });
    expect(manager.save).toHaveBeenCalledTimes(1); // só o projeto
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({ reservedCredits: 0, consumedCredits: 0 });
  });

  it('título vira "(cópia N)" contando as cópias que já existem', async () => {
    await service.duplicateProject(userId, 'p1', {});
    expect(saved[0]).toMatchObject({ title: 'Ofertas da semana (cópia 1)' });

    projectCount.mockResolvedValue(2);
    saved.length = 0;
    await service.duplicateProject(userId, 'p1', {});
    expect(saved[0]).toMatchObject({ title: 'Ofertas da semana (cópia 3)' });
  });

  it('duplicar uma cópia não empilha sufixos', async () => {
    source.title = 'Ofertas da semana (cópia 2)';
    projectCount.mockResolvedValue(2);
    await service.duplicateProject(userId, 'p1', {});
    expect(saved[0]).toMatchObject({ title: 'Ofertas da semana (cópia 3)' });
  });

  it('título longo é cortado sem perder o sufixo (varchar(120))', async () => {
    source.title = 'x'.repeat(200);
    await service.duplicateProject(userId, 'p1', {});
    const title = (saved[0] as { title: string }).title;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith(' (cópia 1)')).toBe(true);
  });

  it('emite evento de auditoria + notify no canal mc_events', async () => {
    await service.duplicateProject(userId, 'p1', { aspectRatio: '1:1' });
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        kind: 'project_duplicated',
        refKind: 'project',
        detail: expect.objectContaining({ sourceProjectId: 'p1', aspectRatio: '1:1' }),
      }),
    );
    expect(transitions.notify).toHaveBeenCalled();
  });

  it.each([
    McProjectStatus.STORYBOARD_REVIEW,
    McProjectStatus.SUCCEEDED,
    McProjectStatus.NEEDS_ATTENTION,
  ])('permite duplicar a partir de %s', async (status) => {
    source.status = status;
    await expect(service.duplicateProject(userId, 'p1', {})).resolves.toBeDefined();
  });

  it.each([McProjectStatus.SCRIPTING, McProjectStatus.GENERATING, McProjectStatus.FAILED])(
    'recusa duplicar a partir de %s',
    async (status) => {
      source.status = status;
      await expect(service.duplicateProject(userId, 'p1', {})).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('projeto sem roteiro não é duplicável', async () => {
    source.script = null;
    await expect(service.duplicateProject(userId, 'p1', {})).rejects.toMatchObject({
      response: { code: 'PROJECT_WITHOUT_SCRIPT' },
    });
  });

  it('projeto de outro usuário → 403', async () => {
    source.userId = 'outro';
    await expect(service.duplicateProject(userId, 'p1', {})).rejects.toMatchObject({ status: 403 });
  });

  /**
   * O ponto do plano §6.3: "duplicar em outro formato reaproveita roteiro e
   * falas". O hash do TTS NÃO inclui aspectRatio, então o approve da cópia
   * encontra o mesmo hash e nasce skipped_cached; o do keyframe INCLUI, então
   * o enquadramento novo é gerado — que é o comportamento correto.
   */
  it('hash do TTS sobrevive à troca de formato (cache); o do keyframe muda', () => {
    const base = {
      kitId: 'kit-1',
      kitVersion: 1,
      voiceId: 'v1',
      actionPrompt: 'Mascote acena no corredor',
      dialogue: 'Bem-vindo às ofertas!',
      durationS: 6,
      generation: 1,
    };
    const original = computeSceneStepHashes({ ...base, aspectRatio: '9:16' });
    const copia = computeSceneStepHashes({ ...base, aspectRatio: '1:1' });

    expect(copia.tts).toBe(original.tts);
    expect(copia.keyframe).not.toBe(original.keyframe);
  });
});
