import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import { MC_PIPELINE_V2, resolveQuality } from '../domain/mc-quality';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';
import { McQualityService } from './mc-quality.service';
import { McTranslationService } from './mc-translation.service';

/**
 * Costura da tarefa 4.6 na aprovação da produção (D9b): roteiro F1 com
 * `logoFace: true` e caixa do logo não confirmada → 422 LOGO_BOX_REQUIRED
 * ANTES de qualquer reserva/materialização. A regra em si é testada em
 * domain/mc-logo-face.spec.ts; aqui só a chamada em `approveProduction`.
 */
describe('McQualityService.approveProduction — rosto do logo exige caixa confirmada (4.6)', () => {
  const userId = 'u1';
  const TX_REACHED = new Error('passou do bloqueio do rosto do logo');
  let project: Record<string, unknown>;
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let materializer: Record<string, jest.Mock>;
  let service: McQualityService;

  beforeEach(() => {
    project = {
      id: 'p1',
      userId,
      kitId: 'k1',
      status: McProjectStatus.VISUAL_REVIEW,
      pipelineVersion: MC_PIPELINE_V2,
      format: 'talking_art',
      tier: 'economico',
      revision: 3,
      script: { ...fixtureTalkTileScript(), logoFace: true },
      logoBox: null,
      quality: {
        ...resolveQuality(null),
        preparation: { revision: 3, hash: 'h-3', completedAt: '2026-10-12T10:00:00Z' },
      },
      options: { musicEnabled: true, captionsEnabled: true, products: [] },
      reservedCredits: 0,
    };
    const kit = {
      id: 'k1',
      userId,
      status: McKitStatus.APPROVED,
      source: 'logo',
      identityMode: 'logo_as_is',
      tileAssetId: 't1',
    };
    const repos = new Map<unknown, Record<string, jest.Mock>>([
      [McProject, { findOneBy: jest.fn(() => Promise.resolve({ ...project })) }],
      [McCharacterKit, { findOneBy: jest.fn().mockResolvedValue(kit) }],
      [McScene, { find: jest.fn().mockResolvedValue([]) }],
      [AnimationAsset, { find: jest.fn().mockResolvedValue([]) }],
    ]);
    dataSource = {
      getRepository: jest.fn((entity: unknown) => repos.get(entity)),
      transaction: jest.fn().mockRejectedValue(TX_REACHED),
    };
    materializer = { materializeProductionV2: jest.fn(), ensureAssemblyStepV2: jest.fn() };
    service = new McQualityService(
      dataSource as unknown as DataSource,
      {} as TaskTransitionService,
      { get: jest.fn().mockResolvedValue(false) } as unknown as SystemSettingsService,
      {} as CreditsService,
      {} as ModerationProvider,
      {} as CommercialsService,
      materializer as unknown as McMaterializerService,
      {} as McPipelineService,
      {} as McTranslationService,
    );
  });

  const approve = () =>
    service.approveProduction(userId, 'p1', { expectedRevision: 3, manifestHash: 'h-3' } as never);

  const rejection = async () => {
    try {
      await approve();
    } catch (err) {
      return err;
    }
    throw new Error('esperava rejeição');
  };

  it('sem caixa → 422 LOGO_BOX_REQUIRED com ações detectar/marcar, sem abrir transação', async () => {
    const err = (await rejection()) as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({
      code: 'LOGO_BOX_REQUIRED',
      details: { actions: ['detect_logo_box', 'mark_logo_box'], source: 'none' },
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(materializer.materializeProductionV2).not.toHaveBeenCalled();
  });

  it('proposta detectada não confirmada → 422 LOGO_BOX_REQUIRED', async () => {
    project.logoBox = {
      x: 0.05,
      y: 0.86,
      w: 0.22,
      h: 0.09,
      logoBoxSource: 'detected',
      logoBoxConfidence: 0.92,
      logoBoxConfirmed: false,
    };
    expect(((await rejection()) as HttpException).getResponse()).toMatchObject({
      code: 'LOGO_BOX_REQUIRED',
      details: { source: 'detected' },
    });
  });

  it('caixa confirmada, ou roteiro sem rosto do logo → segue para a reserva', async () => {
    project.logoBox = {
      x: 0.05,
      y: 0.86,
      w: 0.22,
      h: 0.09,
      logoBoxSource: 'detected',
      logoBoxConfidence: 0.92,
      logoBoxConfirmed: true,
    };
    expect(await rejection()).toBe(TX_REACHED);

    project.logoBox = null;
    project.script = { ...fixtureTalkTileScript(), logoFace: false };
    expect(await rejection()).toBe(TX_REACHED);
  });
});
