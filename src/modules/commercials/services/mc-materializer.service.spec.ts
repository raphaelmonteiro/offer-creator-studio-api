import { EntityManager } from 'typeorm';
import { CommercialsService } from '../commercials.service';
import { MC_STEP_CREDITS } from '../domain/mc-pricing.config';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McMaterializerService } from './mc-materializer.service';

/** Manager fake: save coleta entidades com id sequencial; QueryBuilder do cache é configurável. */
function fakeManager(cacheResults: Array<{ id: string; outputAssetId: string } | null> = []) {
  let seq = 0;
  const saved: Array<Record<string, unknown> & { id?: string }> = [];
  const updates: Array<{ where: unknown; patch: unknown }> = [];
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => Promise.resolve(cacheResults.shift() ?? null)),
  };
  const manager = {
    saved,
    updates,
    qb,
    create: jest.fn((_e: unknown, obj: Record<string, unknown>) => ({ ...obj })),
    save: jest.fn((obj: Record<string, unknown> & { id?: string }) => {
      if (!obj.id) obj.id = `id-${++seq}`;
      saved.push(obj);
      return Promise.resolve(obj);
    }),
    update: jest.fn((_e: unknown, where: unknown, patch: unknown) => {
      updates.push({ where, patch });
      return Promise.resolve({ affected: 1 });
    }),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn(() => qb),
  };
  return manager as unknown as EntityManager & typeof manager;
}

const project = {
  id: 'proj-1',
  userId: 'u1',
  kitId: 'kit-1',
  aspectRatio: '9:16',
} as unknown as McProject;

const kit = { id: 'kit-1', userId: 'u1', version: 1, voiceId: 'voice-1' } as McCharacterKit;

function scriptOf(scenes: McScript['scenes'], seal: McScript['seal'] = null): McScript {
  return { version: 1, scenes, seal };
}

describe('McMaterializerService — materialização do roteiro (plano §6.1/§6.3)', () => {
  let commercials: { appendEvent: jest.Mock };
  let service: McMaterializerService;

  beforeEach(() => {
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    service = new McMaterializerService(commercials as unknown as CommercialsService);
  });

  it('cena FALADA gera 4 steps + assembly — video nasce skipped_cached (audio-driven)', async () => {
    const manager = fakeManager();
    const scenes = await service.materializeApproval(
      manager,
      project,
      kit,
      scriptOf([{ idx: 0, actionPrompt: 'Mascote acena', dialogue: 'Olá!', durationS: 10 }]),
    );

    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({ idx: 0, generation: 1, status: McSceneStatus.PENDING });

    const steps = manager.saved.filter((s) => 'inputHash' in s || s.type === McStepType.ASSEMBLY);
    const byType = Object.fromEntries(steps.map((s) => [s.type, s]));
    expect(Object.keys(byType).sort()).toEqual(
      [
        McStepType.ASSEMBLY,
        McStepType.KEYFRAME,
        McStepType.LIPSYNC,
        McStepType.TTS,
        McStepType.VIDEO,
      ].sort(),
    );
    expect(byType[McStepType.KEYFRAME].status).toBe(McStepStatus.PENDING);
    expect(byType[McStepType.TTS].status).toBe(McStepStatus.PENDING);
    expect(byType[McStepType.LIPSYNC].status).toBe(McStepStatus.PENDING);
    // o Avatar (lipsync) substitui o step de vídeo — skipped satisfaz o scheduler
    expect(byType[McStepType.VIDEO].status).toBe(McStepStatus.SKIPPED_CACHED);
    expect(byType[McStepType.ASSEMBLY].status).toBe(McStepStatus.PENDING);
    // custos de tabela gravados por step
    expect(byType[McStepType.LIPSYNC].costCredits).toBe(MC_STEP_CREDITS[McStepType.LIPSYNC]);
    expect(byType[McStepType.VIDEO].costCredits).toBe(MC_STEP_CREDITS[McStepType.VIDEO]);
  });

  it('cena MUDA gera só keyframe + video (pending) — sem tts/lipsync', async () => {
    const manager = fakeManager();
    await service.materializeApproval(
      manager,
      project,
      kit,
      scriptOf([{ idx: 0, actionPrompt: 'Panorâmica da loja', dialogue: null, durationS: 8 }]),
    );
    const steps = manager.saved.filter((s) => 'inputHash' in s);
    const types = steps.map((s) => s.type).sort();
    expect(types).toEqual([McStepType.ASSEMBLY, McStepType.KEYFRAME, McStepType.VIDEO].sort());
    const video = steps.find((s) => s.type === McStepType.VIDEO);
    expect(video?.status).toBe(McStepStatus.PENDING); // muda: o video RODA (final da cena)
  });

  it('N cenas: cada uma com seus steps + UM assembly por projeto', async () => {
    const manager = fakeManager();
    await service.materializeApproval(
      manager,
      project,
      kit,
      scriptOf([
        { idx: 0, actionPrompt: 'Abre', dialogue: 'Oi!', durationS: 5 },
        { idx: 1, actionPrompt: 'Fecha', dialogue: null, durationS: 5 },
      ]),
    );
    const steps = manager.saved.filter((s) => 'inputHash' in s);
    expect(steps.filter((s) => s.type === McStepType.ASSEMBLY)).toHaveLength(1);
    expect(steps.filter((s) => s.type === McStepType.KEYFRAME)).toHaveLength(2);
    expect(steps.filter((s) => s.type === McStepType.LIPSYNC)).toHaveLength(1);
  });

  it('CACHE (§6.3): tts com hash já succeeded do MESMO usuário nasce skipped_cached apontando o asset', async () => {
    // 1º lookup (keyframe) sem hit; 2º (tts) com hit
    const manager = fakeManager([null, { id: 'step-antigo', outputAssetId: 'asset-tts' }]);
    await service.materializeApproval(
      manager,
      project,
      kit,
      scriptOf([{ idx: 0, actionPrompt: 'Acena', dialogue: 'Olá de novo!', durationS: 10 }]),
    );
    const tts = manager.saved.find((s) => s.type === McStepType.TTS);
    expect(tts?.status).toBe(McStepStatus.SKIPPED_CACHED);
    expect(tts?.outputAssetId).toBe('asset-tts');
    // atalho da cena acompanha o asset reaproveitado
    expect(
      manager.updates.some(
        (u) => (u.patch as { audioAssetId?: string }).audioAssetId === 'asset-tts',
      ),
    ).toBe(true);
    // evento de auditoria do skip
    expect(
      commercials.appendEvent.mock.calls.some(
        ([, e]) =>
          (e as { toStatus?: string; detail?: { reason?: string } }).toStatus ===
            McStepStatus.SKIPPED_CACHED &&
          (e as { detail?: { reason?: string } }).detail?.reason === 'cache_hit',
      ),
    ).toBe(true);
  });

  it('re-roll (createSceneSteps na geração 2): lipsync novo PENDING mesmo com keyframe/tts em cache', async () => {
    const manager = fakeManager([
      { id: 's-kf', outputAssetId: 'asset-kf' },
      { id: 's-tts', outputAssetId: 'asset-tts' },
    ]);
    const scene = {
      id: 'scene-1',
      projectId: 'proj-1',
      idx: 0,
      generation: 2,
      status: McSceneStatus.PENDING,
      actionPrompt: 'Acena',
      dialogue: 'Olá!',
      durationS: 10,
      videoAssetId: null,
    } as unknown as McScene;
    const steps = await service.createSceneSteps(manager, project, kit, scene);
    const byType = Object.fromEntries(steps.map((s) => [s.type, s]));
    expect(byType[McStepType.KEYFRAME].status).toBe(McStepStatus.SKIPPED_CACHED);
    expect(byType[McStepType.KEYFRAME].outputAssetId).toBe('asset-kf');
    expect(byType[McStepType.TTS].status).toBe(McStepStatus.SKIPPED_CACHED);
    expect(byType[McStepType.VIDEO].status).toBe(McStepStatus.SKIPPED_CACHED);
    expect(byType[McStepType.LIPSYNC].status).toBe(McStepStatus.PENDING); // generation no hash: refaz
    expect(byType[McStepType.LIPSYNC].sceneGeneration).toBe(2);
  });

  it('ensureAssemblyStep: atualiza o hash de um pendente existente em vez de duplicar', async () => {
    const manager = fakeManager();
    (manager.findOne as jest.Mock).mockResolvedValue({
      id: 'asm-1',
      inputHash: 'hash-velho',
      status: McStepStatus.PENDING,
    });
    const step = await service.ensureAssemblyStep(manager, project, [{ idx: 0, generation: 2 }], {
      seal: null,
    });
    expect(step.id).toBe('asm-1');
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.updates.some((u) => (u.patch as { inputHash?: string }).inputHash)).toBe(true);
  });
});
