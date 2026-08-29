import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { CreditsService, creditsEnabled } from '../../shared/credits/credits.service';
import { AnimationAsset } from '../../shared/media-assets/animation-asset.entity';
import { MC_EVENTS_CHANNEL } from '../../shared/events/animation-events.service';
import { AnimationQueueService, QUEUES } from '../../shared/queue/animation-queue.service';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../shared/state/task-transition.service';
import { computeInputHash, MC_BUILDER_VERSIONS } from './domain/input-hash';
import { MC_PROJECT_MINI_RESERVE_CREDITS, MC_STEP_CREDITS } from './domain/mc-pricing.config';
import {
  assertProjectTransition,
  assertStepTransition,
  McProjectStatus,
  McStepStatus,
} from './domain/mc-state-machines';
import { McStepType, resolveProjectOptions } from './domain/mc-types';
import { CreateProjectDto } from './dto/create-project.dto';
import { McCharacterKit, McKitStatus } from './entities/mc-character-kit.entity';
import { McEvent } from './entities/mc-event.entity';
import { McProject } from './entities/mc-project.entity';
import { McScene } from './entities/mc-scene.entity';
import { McStep } from './entities/mc-step.entity';

/** Jobs de LLM são curtos — expiração de 120s por publish (plano §6.4: expireInSeconds POR FILA). */
const MC_LLM_EXPIRE_S = 120;

/**
 * Kill-switch em banco (plano §6.7): 'mc_paused' = true pausa a criação de
 * comerciais sem redeploy. Gravada pela rota admin POST /commercials/admin/pause
 * e checada a cada enqueue via SystemSettingsService.get (cache de 10s).
 */
export const MC_PAUSED_KEY = 'mc_paused';

@Injectable()
export class CommercialsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly queue: AnimationQueueService,
    private readonly settings: SystemSettingsService,
    private readonly credits: CreditsService,
  ) {}

  /**
   * Criação do projeto (fatia vertical da Fase 0): valida ownership do kit,
   * cria o projeto em 'draft', CAS draft → scripting, cria o step 'script'
   * (com inputHash canônico), enfileira em mc.llm e emite evento + pg_notify —
   * TUDO NA MESMA TRANSAÇÃO (padrão do animations; pg-boss é Postgres).
   */
  async createProject(userId: string, dto: CreateProjectDto): Promise<McProject> {
    // Kill-switch em banco (plano §6.7): pausa operacional sem redeploy.
    // `get` com cache de 10s — a pausa/retomada propaga em até 10s por processo.
    if ((await this.settings.get<boolean>(MC_PAUSED_KEY)) === true) {
      throw new HttpException(
        {
          code: 'MC_PAUSED',
          message: 'Geração de comerciais pausada temporariamente pelo administrador',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: dto.kitId });
    if (!kit) throw new NotFoundException('Kit não encontrado');
    if (kit.userId !== userId) throw new ForbiddenException();
    if (kit.status !== McKitStatus.APPROVED) {
      throw new BadRequestException({
        code: 'KIT_NOT_APPROVED',
        message: 'O kit do mascote precisa estar aprovado para criar um comercial',
      });
    }

    return this.dataSource.transaction(async (manager) => {
      // CRÉDITOS (plano §6.7): mini-reserva fixa de 10 cr na criação; a
      // reserva PRINCIPAL (custoDoProjeto do roteiro) acontece na aprovação
      // do storyboard. Com creditsEnabled('commercials') off (default até o
      // go-live, flag MC_CREDITS_ENABLED) a reserva é 0 e nada vai ao ledger.
      const reservedCredits = creditsEnabled('commercials') ? MC_PROJECT_MINI_RESERVE_CREDITS : 0;

      // Contrato v1-B1: aspectRatio default 9:16; música/legendas default on;
      // produtos (máx. 6) chegam prontos do front (name+price) e viram os
      // selos determinísticos do roteiro/montagem (plano §5.4).
      const aspectRatio = dto.aspectRatio ?? '9:16';
      const options = resolveProjectOptions({
        musicEnabled: dto.musicEnabled,
        captionsEnabled: dto.captionsEnabled,
        products: dto.products,
      });

      const project = manager.create(McProject, {
        userId,
        kitId: kit.id,
        title: dto.title,
        briefing: dto.briefing,
        aspectRatio,
        targetDurationS: dto.targetDurationS,
        options,
        status: McProjectStatus.DRAFT,
        reservedCredits,
      });
      await manager.save(project);

      // Débito NA MESMA transação do enqueue (pg-boss é Postgres): saldo
      // insuficiente lança 402 INSUFFICIENT_CREDITS e nada é criado/enfileirado.
      // ACOPLAMENTO AO LEDGER: ai_credit_ledger.taskId é uma coluna livre
      // (sem FK para animation_tasks) — aqui ela carrega o mc_projects.id como
      // referência genérica, schema inalterado. Quando o ledger ganhar
      // ref_kind/ref_id (migration aditiva do plano §6.7), este call site é o
      // único a ajustar.
      await this.credits.reserve(manager, userId, project.id, reservedCredits);

      // draft → scripting (CAS mesmo dentro da própria transação: exercita a
      // matriz e deixa a trilha de auditoria desde o primeiro estado)
      assertProjectTransition(McProjectStatus.DRAFT, McProjectStatus.SCRIPTING);
      await this.transitions.casTransition(
        manager,
        McProject,
        project.id,
        McProjectStatus.DRAFT,
        McProjectStatus.SCRIPTING,
      );
      await this.appendEvent(manager, {
        userId,
        refKind: 'project',
        refId: project.id,
        kind: 'transition',
        fromStatus: McProjectStatus.DRAFT,
        toStatus: McProjectStatus.SCRIPTING,
        detail: { title: dto.title },
      });

      // step 'script' com hash canônico (kitVersion entra no hash: kit novo ⇒
      // roteiro novo, plano §6.3)
      const inputHash = computeInputHash(McStepType.SCRIPT, MC_BUILDER_VERSIONS.script, {
        briefing: dto.briefing,
        aspectRatio,
        targetDurationS: dto.targetDurationS,
        kitId: kit.id,
        kitVersion: kit.version,
        // Produtos entram no hash: mudar a oferta muda o roteiro (as falas
        // citam os produtos), então o roteiro antigo não pode ser reusado.
        products: options.products,
      });
      const step = manager.create(McStep, {
        projectId: project.id,
        sceneId: null,
        sceneGeneration: null,
        type: McStepType.SCRIPT,
        status: McStepStatus.PENDING,
        inputHash,
        costCredits: MC_STEP_CREDITS[McStepType.SCRIPT],
      });
      await manager.save(step);

      assertStepTransition(McStepStatus.PENDING, McStepStatus.QUEUED);
      await this.transitions.casTransition(
        manager,
        McStep,
        step.id,
        McStepStatus.PENDING,
        McStepStatus.QUEUED,
      );
      await this.appendEvent(manager, {
        userId,
        refKind: 'step',
        refId: step.id,
        kind: 'transition',
        fromStatus: McStepStatus.PENDING,
        toStatus: McStepStatus.QUEUED,
        detail: { type: McStepType.SCRIPT, projectId: project.id },
      });

      await this.queue.publish(
        QUEUES.MC_LLM,
        { stepId: step.id, projectId: project.id },
        { expireInSeconds: MC_LLM_EXPIRE_S },
      );

      // v0: eventos mc_* saem no canal DEDICADO 'mc_events' (payload
      // inalterado), consumido pelo SSE próprio em GET /commercials/events —
      // o stream do animations não recebe mais eventos deste módulo.
      await this.transitions.notify(
        manager,
        userId,
        {
          kind: 'mc_project',
          projectId: project.id,
          status: McProjectStatus.SCRIPTING,
        },
        MC_EVENTS_CHANNEL,
      );

      return manager.findOneByOrFail(McProject, { id: project.id });
    });
  }

  async findAllProjects(
    userId: string,
  ): Promise<Array<McProject & { finalUrl: string | null; posterUrl: string | null }>> {
    const projects = await this.dataSource.getRepository(McProject).find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    const urls = await this.resolveAssetUrls(projects.map((p) => p.finalAssetId));
    return projects.map((p) => ({
      ...p,
      finalUrl: (p.finalAssetId && urls.get(p.finalAssetId)?.fileUrl) || null,
      posterUrl: (p.finalAssetId && urls.get(p.finalAssetId)?.posterUrl) || null,
    }));
  }

  /** Projeto + cenas + steps (visão completa para a UI de acompanhamento). */
  async findOneProject(
    userId: string,
    id: string,
  ): Promise<
    McProject & {
      finalUrl: string | null;
      posterUrl: string | null;
      scenes: Array<McScene & { keyframeUrl: string | null; finalUrl: string | null }>;
      steps: McStep[];
    }
  > {
    const project = await this.dataSource.getRepository(McProject).findOneBy({ id });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    if (project.userId !== userId) throw new ForbiddenException();
    const [scenes, steps] = await Promise.all([
      this.dataSource.getRepository(McScene).find({
        where: { projectId: id },
        order: { idx: 'ASC' },
      }),
      this.dataSource.getRepository(McStep).find({
        where: { projectId: id },
        order: { createdAt: 'ASC' },
      }),
    ]);
    // URLs denormalizadas — a UI consome finalUrl/posterUrl no projeto e
    // keyframeUrl/finalUrl por cena sem precisar de um endpoint de assets.
    const urls = await this.resolveAssetUrls([
      project.finalAssetId,
      ...scenes.flatMap((s) => [s.keyframeAssetId, s.finalAssetId]),
    ]);
    return {
      ...project,
      finalUrl: (project.finalAssetId && urls.get(project.finalAssetId)?.fileUrl) || null,
      posterUrl: (project.finalAssetId && urls.get(project.finalAssetId)?.posterUrl) || null,
      scenes: scenes.map((s) => ({
        ...s,
        keyframeUrl: (s.keyframeAssetId && urls.get(s.keyframeAssetId)?.fileUrl) || null,
        finalUrl: (s.finalAssetId && urls.get(s.finalAssetId)?.fileUrl) || null,
      })),
      steps,
    };
  }

  /** Resolve fileUrl/posterUrl de um conjunto de asset ids (ignora nulos e ausentes). */
  private async resolveAssetUrls(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, { fileUrl: string | null; posterUrl: string | null }>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (unique.length === 0) return new Map();
    const assets = await this.dataSource
      .getRepository(AnimationAsset)
      .find({ where: { id: In(unique) } });
    return new Map(
      assets.map((a) => [a.id, { fileUrl: a.fileUrl ?? null, posterUrl: a.posterUrl ?? null }]),
    );
  }

  /**
   * Evento de auditoria em mc_events — o análogo do appendEvent do
   * TaskTransitionService (que grava em animation_task_events) para as
   * entidades deste módulo. Mesma transação do CAS + notify.
   */
  async appendEvent(
    manager: EntityManager,
    event: {
      userId: string;
      refKind: 'kit' | 'project' | 'scene' | 'step';
      refId: string;
      kind: string;
      fromStatus?: string | null;
      toStatus?: string | null;
      detail?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await manager.insert(McEvent, {
      userId: event.userId,
      refKind: event.refKind,
      refId: event.refId,
      kind: event.kind,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      detail: event.detail ?? null,
    });
  }
}
