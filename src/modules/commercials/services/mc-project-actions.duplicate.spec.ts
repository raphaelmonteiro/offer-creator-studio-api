import { UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { MC_EMPTY_QUALITY, MC_PIPELINE_V2 } from '../domain/mc-quality';
import { computeSceneStepHashes } from '../domain/mc-step-hashes';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
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
  let manager: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let sourceScenes: Row[];
  let sourceSteps: Row[];
  const originalFormats = process.env.MC_FORMATS;
  const originalPipelineV2 = process.env.MC_PIPELINE_V2;
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
    sourceScenes = [];
    sourceSteps = [];
    let seq = 0;
    manager = {
      create: jest.fn((_e: unknown, obj: Record<string, unknown>) => ({ ...obj })),
      save: jest.fn((obj: Record<string, unknown>) => {
        // como o TypeORM: o id é atribuído NA entidade salva (o service lê
        // `copy.id` para cenas/steps clonados e para o evento). O primeiro save
        // é o projeto (p2); cenas/steps clonados ganham ids sequenciais.
        if (!obj.id) obj.id = saved.length === 0 ? 'p2' : `row-${++seq}`;
        saved.push(obj);
        return Promise.resolve(obj);
      }),
      find: jest.fn((entity: unknown) => {
        if (entity === McScene) return Promise.resolve(sourceScenes);
        if (entity === McStep) return Promise.resolve(sourceSteps);
        return Promise.resolve([]);
      }),
    };
    delete process.env.MC_FORMATS;
    // F1/F2 exigem o executor v2 para todos (D6); os testes de formato novo partem daqui.
    process.env.MC_PIPELINE_V2 = 'all';
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

  afterEach(() => {
    if (originalFormats === undefined) delete process.env.MC_FORMATS;
    else process.env.MC_FORMATS = originalFormats;
    if (originalPipelineV2 === undefined) delete process.env.MC_PIPELINE_V2;
    else process.env.MC_PIPELINE_V2 = originalPipelineV2;
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

  // Aspecto × formato (video-formatos-personagem, design D12): o F3 monta em 720p e recusa 4:5.
  it('origem scenes + aspectRatio 4:5 → 422 ASPECT_NOT_SUPPORTED_FOR_FORMAT, nada salvo', async () => {
    const promise = service.duplicateProject(userId, 'p1', { aspectRatio: '4:5' });
    await expect(promise).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({
        code: 'ASPECT_NOT_SUPPORTED_FOR_FORMAT',
        details: expect.objectContaining({ format: 'scenes', aspectRatio: '4:5' }),
      }),
    });
    expect(saved).toHaveLength(0);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(commercials.appendEvent).not.toHaveBeenCalled();
  });

  it('cópia herda format/tier da origem (origem anterior à migration lê scenes/economico)', async () => {
    await service.duplicateProject(userId, 'p1', { aspectRatio: '1:1' });
    expect(saved[0]).toMatchObject({ format: 'scenes', tier: 'economico' });

    saved.length = 0;
    process.env.MC_FORMATS = 'talking_art';
    source.format = 'talking_art';
    source.tier = 'premium';
    await service.duplicateProject(userId, 'p1', { aspectRatio: '4:5' });
    expect(saved[0]).toMatchObject({ format: 'talking_art', tier: 'premium', aspectRatio: '4:5' });
  });

  // ── change video-formatos-personagem (D6, tarefa 3.8): tier, campos de formato, gate e reuso de TTS ──

  it('`tier` do DTO sobrepõe o da origem: "duplicar como econômico" de um projeto premium', async () => {
    source.tier = 'premium';
    await service.duplicateProject(userId, 'p1', { tier: 'economico' });
    expect(saved[0]).toMatchObject({ tier: 'economico', format: 'scenes' });
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ detail: expect.objectContaining({ tier: 'economico' }) }),
    );
  });

  it('a cópia carrega pipelineVersion, format, channel, backgroundArtAssetId, sourceArt, layoutPreset e logoBox; nasce com revision 0 e quality vazio', async () => {
    process.env.MC_FORMATS = 'talking_art';
    Object.assign(source, {
      pipelineVersion: MC_PIPELINE_V2,
      format: 'talking_art',
      channel: 'instagram',
      backgroundArtAssetId: 'art-1',
      sourceArt: { kind: 'social', id: 'fl-1', pageIndex: 0, snapshotHash: 'h' },
      layoutPreset: 'canto_inferior_direito',
      logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
      revision: 7,
      quality: { approval: { scope: 'production' }, budgets: [{ phase: 'production' }] },
    });
    await service.duplicateProject(userId, 'p1', {});
    expect(saved[0]).toMatchObject({
      pipelineVersion: MC_PIPELINE_V2,
      format: 'talking_art',
      channel: 'instagram',
      backgroundArtAssetId: 'art-1',
      sourceArt: { kind: 'social', id: 'fl-1', pageIndex: 0, snapshotHash: 'h' },
      layoutPreset: 'canto_inferior_direito',
      logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
      revision: 0,
      quality: MC_EMPTY_QUALITY,
    });
    // jsonb independentes da origem
    expect((saved[0] as { sourceArt: unknown }).sourceArt).not.toBe(source.sourceArt);
    expect((saved[0] as { logoBox: unknown }).logoBox).not.toBe(source.logoBox);
  });

  it('origem legada (pipelineVersion 1) copia sem quality e sem clonar cenas', async () => {
    source.pipelineVersion = 1;
    await service.duplicateProject(userId, 'p1', {});
    expect(saved[0]).toMatchObject({ pipelineVersion: 1, quality: null, revision: 0 });
    expect(manager.find).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
  });

  it('formato novo com MC_PIPELINE_V2=off → 422 PIPELINE_V2_REQUIRED (tarefa 4.2); ligado, a cópia nasce v2 mesmo de origem legada', async () => {
    process.env.MC_FORMATS = 'talking_art';
    process.env.MC_PIPELINE_V2 = 'off';
    source.format = 'talking_art';
    await expect(service.duplicateProject(userId, 'p1', {})).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'PIPELINE_V2_REQUIRED' }),
    });
    expect(saved).toHaveLength(0);

    process.env.MC_PIPELINE_V2 = 'all';
    source.pipelineVersion = 1; // origem anterior à change: a cópia F1 é SEMPRE v2 com quality vazio
    await service.duplicateProject(userId, 'p1', {});
    expect(saved[0]).toMatchObject({
      format: 'talking_art',
      pipelineVersion: MC_PIPELINE_V2,
      revision: 0,
      quality: MC_EMPTY_QUALITY,
    });
  });

  it('formato novo fora de MC_FORMATS → 422 FORMAT_NOT_ENABLED antes de qualquer escrita', async () => {
    source.format = 'talking_art';
    await expect(service.duplicateProject(userId, 'p1', {})).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'FORMAT_NOT_ENABLED' }),
    });
    expect(saved).toHaveLength(0);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('reuso de TTS (v2): as falas SELECIONADAS da origem viram cenas + steps tts skipped_cached na cópia (mesmo baseHash/outputAssetId)', async () => {
    source.pipelineVersion = MC_PIPELINE_V2;
    sourceScenes = [
      {
        id: 'src-sc-1',
        projectId: 'p1',
        idx: 0,
        scriptSceneId: 'fx-talk-1',
        sceneType: 'talk_tile',
        status: McSceneStatus.READY,
        durationS: 6,
        actionPrompt: '',
        dialogue: 'Olá!',
        audioAssetId: 'au-1',
      },
      {
        id: 'src-sc-2',
        projectId: 'p1',
        idx: 1,
        scriptSceneId: 'fx-talk-2',
        sceneType: 'talk_tile',
        status: McSceneStatus.READY,
        durationS: 7,
        actionPrompt: '',
        dialogue: 'Arroz em oferta',
        audioAssetId: null, // sem áudio selecionado: nada a reaproveitar
      },
      {
        id: 'src-sc-3',
        projectId: 'p1',
        idx: 2,
        scriptSceneId: 'fx-talk-3',
        sceneType: 'talk_tile',
        status: McSceneStatus.CANCELED, // cena removida: ignorada
        durationS: 5,
        actionPrompt: '',
        dialogue: 'x',
        audioAssetId: 'au-3',
      },
    ];
    sourceSteps = [
      {
        id: 'src-tts-old',
        sceneId: 'src-sc-1',
        type: McStepType.TTS,
        status: McStepStatus.SUCCEEDED,
        outputAssetId: 'au-1-old',
        inputHash: 'hash-old',
        attempt: 1,
        inputSnapshot: { baseHash: 'base-1', dialogue: 'Olá?' },
      },
      {
        id: 'src-tts-sel',
        sceneId: 'src-sc-1',
        type: McStepType.TTS,
        status: McStepStatus.SUCCEEDED,
        outputAssetId: 'au-1', // o SELECIONADO
        inputHash: 'hash-sel',
        attempt: 2,
        provider: 'real',
        inputSnapshot: { baseHash: 'base-1', dialogue: 'Olá!' },
      },
      {
        id: 'src-talk',
        sceneId: 'src-sc-1',
        type: McStepType.TALK,
        status: McStepStatus.FAILED,
        outputAssetId: null,
        inputHash: 'hash-talk',
        attempt: 1,
      },
    ];
    await service.duplicateProject(userId, 'p1', { tier: 'economico' });
    const copyScenes = saved.filter((r) => 'scriptSceneId' in r);
    const copySteps = saved.filter((r) => 'inputHash' in r);
    expect(copyScenes).toHaveLength(1);
    expect(copyScenes[0]).toMatchObject({
      projectId: 'p2',
      scriptSceneId: 'fx-talk-1',
      idx: 0,
      generation: 1,
      status: McSceneStatus.PENDING,
      audioAssetId: 'au-1',
      dialogue: 'Olá!',
    });
    expect(copySteps).toHaveLength(1); // só o tts selecionado — o talk falhado NÃO é copiado
    expect(copySteps[0]).toMatchObject({
      projectId: 'p2',
      sceneId: copyScenes[0].id,
      type: McStepType.TTS,
      status: McStepStatus.SKIPPED_CACHED,
      inputHash: 'hash-sel',
      outputAssetId: 'au-1',
      attempt: 2,
      projectRevision: 0,
      phase: 'preparation',
      costCredits: 0,
      inputSnapshot: { baseHash: 'base-1', dialogue: 'Olá!' },
    });
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ detail: expect.objectContaining({ reusedTts: 1 }) }),
    );
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
