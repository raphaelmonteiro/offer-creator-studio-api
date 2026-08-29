import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Like } from 'typeorm';
import { CreditsService, creditsEnabled } from '../../../shared/credits/credits.service';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import {
  ModerationProvider,
  ModerationResult,
} from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService, MC_PAUSED_KEY } from '../commercials.service';
import { custoDaCena, custoDoProjeto } from '../domain/mc-pricing.config';
import {
  assertProjectTransition,
  assertSceneTransition,
  McProjectStatus,
  McSceneStatus,
} from '../domain/mc-state-machines';
import { McScript, resolveProjectOptions } from '../domain/mc-types';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { DuplicateProjectDto } from '../dto/duplicate-project.dto';
import { UpdateScriptDto } from '../dto/update-script.dto';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';

/**
 * Ações do usuário sobre o projeto (plano-comerciais §7.2 — fluxo com gates):
 * aprovação do storyboard (GATE que dispara o gasto 10×), edição do roteiro
 * antes de aprovar, re-roll por cena, regravação de fala e cancelamento.
 *
 * Toda mutação segue o padrão do módulo: kill-switch → moderação ANTES de
 * gastar (§6.8) → transação única com CAS + materialização + reserva +
 * enqueue (pg-boss é Postgres: 402 de créditos aborta TUDO — nada
 * materializado, nada enfileirado).
 */
@Injectable()
export class McProjectActionsService {
  private readonly logger = new Logger(McProjectActionsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly settings: SystemSettingsService,
    private readonly credits: CreditsService,
    private readonly moderation: ModerationProvider,
    private readonly commercials: CommercialsService,
    private readonly materializer: McMaterializerService,
    private readonly pipeline: McPipelineService,
  ) {}

  // ───────────────────── aprovação do storyboard (GATE) ─────────────────────

  /**
   * POST /commercials/projects/:id/approve — o GATE humano (plano §7.2):
   * storyboard_review → generating com, NA MESMA TRANSAÇÃO, a reserva
   * principal (custoDoProjeto do roteiro, §6.7), a materialização de
   * mc_scenes/mc_steps e o enqueue dos steps desbloqueados.
   */
  async approve(userId: string, projectId: string): Promise<McProject> {
    await this.assertNotPaused();
    const project = await this.getOwnedProject(userId, projectId);
    if (project.status !== McProjectStatus.STORYBOARD_REVIEW) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_NOT_IN_REVIEW',
        message: `O projeto está em '${project.status}' — só storyboards em revisão podem ser aprovados.`,
      });
    }
    const script = project.script;
    if (!script || !Array.isArray(script.scenes) || script.scenes.length === 0) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_WITHOUT_SCRIPT',
        message: 'O projeto ainda não tem roteiro para aprovar.',
      });
    }
    const kit = await this.dataSource
      .getRepository(McCharacterKit)
      .findOneBy({ id: project.kitId });
    if (!kit || kit.status !== McKitStatus.APPROVED) {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_APPROVED',
        message: 'O kit do mascote precisa estar aprovado para gerar o comercial.',
      });
    }

    // Moderação do ROTEIRO antes de aprovar/gastar (plano §6.8) — texto das
    // cenas (ação + fala) + selo; resultado auditado no jsonb do projeto.
    const moderation = await this.moderateOrFail(this.scriptText(script));
    if (moderation.flagged) {
      await this.auditBlockedModeration(userId, project.id, moderation);
      throw new UnprocessableEntityException({
        code: 'SCRIPT_MODERATION_BLOCKED',
        message:
          'O roteiro foi bloqueado pela verificação de conteúdo' +
          (moderation.categories.length > 0 ? ` (${moderation.categories.join(', ')})` : '') +
          '. Edite as cenas e tente novamente.',
      });
    }

    await this.dataSource.transaction(async (manager) => {
      // RESERVA PRINCIPAL (plano §6.7) primeiro: 402 aborta a transação
      // inteira — nada materializado, nada enfileirado.
      const reserveDelta = creditsEnabled('commercials') ? custoDoProjeto(script) : 0;
      await this.credits.reserve(manager, userId, project.id, reserveDelta);

      assertProjectTransition(McProjectStatus.STORYBOARD_REVIEW, McProjectStatus.GENERATING);
      const won = await this.transitions.casTransition(
        manager,
        McProject,
        project.id,
        McProjectStatus.STORYBOARD_REVIEW,
        McProjectStatus.GENERATING,
        {
          approvedAt: new Date(),
          reservedCredits: project.reservedCredits + reserveDelta,
          moderation: this.moderationJson(moderation),
        },
      );
      if (!won) {
        throw new UnprocessableEntityException({
          code: 'PROJECT_NOT_IN_REVIEW',
          message: 'O projeto mudou de estado durante a aprovação. Recarregue e tente de novo.',
        });
      }
      await this.pipeline.appendProjectTransition(
        manager,
        userId,
        project.id,
        McProjectStatus.STORYBOARD_REVIEW,
        McProjectStatus.GENERATING,
        { sceneCount: script.scenes.length, reservedDelta: reserveDelta },
      );

      const fresh = await manager.findOneByOrFail(McProject, { id: project.id });
      await this.materializer.materializeApproval(manager, fresh, kit, script);
      await this.pipeline.enqueueReadySteps(manager, project.id);
    });

    return this.dataSource.getRepository(McProject).findOneByOrFail({ id: project.id });
  }

  /**
   * PATCH /commercials/projects/:id/script — edição do roteiro ANTES de
   * aprovar (só storyboard_review). Substitui o script (re-moderação leve) —
   * o usuário ajusta fala/ação e então aprova.
   */
  async updateScript(userId: string, projectId: string, dto: UpdateScriptDto): Promise<McProject> {
    const project = await this.getOwnedProject(userId, projectId);
    if (project.status !== McProjectStatus.STORYBOARD_REVIEW) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_NOT_IN_REVIEW',
        message: `O roteiro só pode ser editado com o storyboard em revisão (status atual: '${project.status}').`,
      });
    }
    // McScript v2: `actionPromptEn` vem do DTO quando o front devolve, e cai
    // no valor ANTERIOR da mesma posição quando o usuário editou só o pt (não
    // perder a versão EN é o que mantém a qualidade do motor de vídeo).
    const previous = project.script?.scenes ?? [];
    const script: McScript = {
      version: (project.script?.version ?? 0) + 1,
      scenes: dto.scenes.map((scene, position) => {
        const actionPromptEn = scene.actionPromptEn?.trim() || previous[position]?.actionPromptEn;
        return {
          idx: position,
          actionPrompt: scene.actionPrompt,
          ...(actionPromptEn ? { actionPromptEn } : {}),
          dialogue: scene.dialogue ?? null,
          durationS: scene.durationS,
        };
      }),
      seal: dto.seal
        ? {
            ...(dto.seal.text ? { text: dto.seal.text } : {}),
            ...(dto.seal.products
              ? { products: dto.seal.products.map((p) => ({ name: p.name, price: p.price })) }
              : {}),
          }
        : null,
      // `endcard` omitido no DTO PRESERVA a cartela atual; `null` remove.
      endcard: dto.endcard === undefined ? (project.script?.endcard ?? null) : dto.endcard,
    };
    const moderation = await this.moderateOrFail(this.scriptText(script));
    if (moderation.flagged) {
      await this.auditBlockedModeration(userId, project.id, moderation);
      throw new UnprocessableEntityException({
        code: 'SCRIPT_MODERATION_BLOCKED',
        message:
          'O novo roteiro foi bloqueado pela verificação de conteúdo' +
          (moderation.categories.length > 0 ? ` (${moderation.categories.join(', ')})` : '') +
          '. Ajuste o texto e tente novamente.',
      });
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        McProject,
        { id: project.id },
        { script, moderation: this.moderationJson(moderation) },
      );
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'project',
        refId: project.id,
        kind: 'script_updated',
        detail: { version: script.version, sceneCount: script.scenes.length },
      });
      await this.transitions.notify(
        manager,
        userId,
        { kind: 'mc_project', projectId: project.id, status: project.status },
        MC_EVENTS_CHANNEL,
      );
    });
    return this.dataSource.getRepository(McProject).findOneByOrFail({ id: project.id });
  }

  // ──────────────────────── duplicar em outro formato ────────────────────────

  /**
   * POST /commercials/projects/:id/duplicate — "duplicar em outro formato"
   * (plano §7.2, entrega da v1). Cria um projeto NOVO do mesmo usuário em
   * `storyboard_review`, com o MESMO roteiro (deep copy), o mesmo kit e as
   * mesmas opções, mudando só o formato.
   *
   * Decisões:
   * - Nasce SEM cenas/steps: quem materializa é o approve (o gate humano
   *   continua sendo o único ponto que dispara gasto, plano §7.2 P1).
   * - Sem reserva de créditos: a mini-reserva da criação paga o roteiro (LLM),
   *   e aqui não há roteiro a gerar — a reserva principal acontece no approve.
   * - O TTS reaproveita o CACHE por hash: o hash do tts é
   *   (fala + voz + cadeia de modelos) e NÃO inclui o formato, então as falas
   *   do original entram como `skipped_cached` — "duplicar em outro formato
   *   reaproveita roteiro e falas" (plano §6.3). Keyframe/video/lipsync mudam
   *   (aspectRatio está no hash do keyframe) e são gerados de novo, como deve
   *   ser: o enquadramento é outro.
   */
  async duplicateProject(
    userId: string,
    projectId: string,
    dto: DuplicateProjectDto,
  ): Promise<McProject> {
    await this.assertNotPaused();
    const source = await this.getOwnedProject(userId, projectId);
    const duplicable: McProjectStatus[] = [
      McProjectStatus.STORYBOARD_REVIEW,
      McProjectStatus.SUCCEEDED,
      McProjectStatus.NEEDS_ATTENTION,
    ];
    if (!duplicable.includes(source.status)) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_NOT_DUPLICABLE',
        message:
          `O projeto está em '${source.status}' — só dá para duplicar comerciais com ` +
          'roteiro aprovado ou já produzidos.',
      });
    }
    if (
      !source.script ||
      !Array.isArray(source.script.scenes) ||
      source.script.scenes.length === 0
    ) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_WITHOUT_SCRIPT',
        message: 'O projeto de origem ainda não tem roteiro para copiar.',
      });
    }
    const kit = await this.getKit(source.kitId);
    const title = await this.nextCopyTitle(userId, source.title);

    const created = await this.dataSource.transaction(async (manager) => {
      const copy = manager.create(McProject, {
        userId,
        kitId: kit.id,
        title,
        briefing: source.briefing,
        // Deep copy: editar o roteiro da cópia NUNCA pode tocar no original
        // (os dois jsonb têm que ser independentes).
        script: JSON.parse(JSON.stringify(source.script)) as McScript,
        aspectRatio: dto.aspectRatio ?? source.aspectRatio,
        targetDurationS: source.targetDurationS,
        options: resolveProjectOptions(source.options),
        status: McProjectStatus.STORYBOARD_REVIEW,
        reservedCredits: 0,
        consumedCredits: 0,
        moderation: source.moderation,
      });
      await manager.save(copy);
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'project',
        refId: copy.id,
        kind: 'project_duplicated',
        toStatus: McProjectStatus.STORYBOARD_REVIEW,
        detail: {
          sourceProjectId: source.id,
          aspectRatio: copy.aspectRatio,
          sceneCount: copy.script?.scenes.length ?? 0,
        },
      });
      await this.transitions.notify(
        manager,
        userId,
        {
          kind: 'mc_project',
          projectId: copy.id,
          status: McProjectStatus.STORYBOARD_REVIEW,
        },
        MC_EVENTS_CHANNEL,
      );
      return copy;
    });
    return this.dataSource.getRepository(McProject).findOneByOrFail({ id: created.id });
  }

  /** Título da cópia: "Original (cópia N)", com N = próxima cópia do usuário. */
  private async nextCopyTitle(userId: string, sourceTitle: string): Promise<string> {
    const base = sourceTitle.replace(/\s*\(cópia \d+\)\s*$/u, '').trim() || sourceTitle;
    const existing = await this.dataSource
      .getRepository(McProject)
      .count({ where: { userId, title: Like(`${base} (cópia %`) } });
    const suffix = ` (cópia ${existing + 1})`;
    // A coluna é varchar(120): o BASE cede espaço, o sufixo nunca é cortado.
    return `${base.slice(0, 120 - suffix.length)}${suffix}`;
  }

  // ─────────────────────────── re-roll e edição ───────────────────────────

  /**
   * POST /commercials/projects/:id/scenes/:idx/reroll — "veio errado"
   * (plano §6.3): generation++, steps novos (keyframe/tts voltam por cache;
   * video/lipsync refeitos), projeto volta a generating. v0: permitido em
   * needs_attention e succeeded (re-roll pós-entrega gera nova montagem).
   * 1º re-roll grátis (embutido no preço, §8); do 2º em diante mini-reserva
   * de custoDaCena quando a cobrança está ligada.
   */
  async rerollScene(userId: string, projectId: string, idx: number): Promise<McScene> {
    await this.assertNotPaused();
    const project = await this.getOwnedProject(userId, projectId);
    // `generating` é permitido SOMENTE para cena já falhada (checado logo
    // abaixo): num comercial multi-cena várias cenas podem falhar juntas (ex.:
    // o provider ficou fora do ar) e o primeiro re-roll devolve o projeto a
    // `generating` — sem isto o usuário teria de refazer uma cena por vez,
    // esperando minutos entre elas. Cenas são independentes no scheduler, então
    // repor uma cena falhada enquanto outra é produzida é seguro por construção.
    this.assertProjectEditable(project, [
      McProjectStatus.NEEDS_ATTENTION,
      McProjectStatus.SUCCEEDED,
      McProjectStatus.GENERATING,
    ]);
    const scene = await this.getScene(project.id, idx);
    if (project.status === McProjectStatus.GENERATING && scene.status !== McSceneStatus.FAILED) {
      throw new UnprocessableEntityException({
        code: 'SCENE_NOT_REROLLABLE',
        message:
          'Esta cena ainda está em produção — espere ela terminar para pedir uma nova tentativa.',
      });
    }
    if (scene.status !== McSceneStatus.READY && scene.status !== McSceneStatus.FAILED) {
      throw new UnprocessableEntityException({
        code: 'SCENE_NOT_REROLLABLE',
        message: `A cena está em '${scene.status}' — só cenas prontas ou falhadas aceitam re-roll.`,
      });
    }
    const kit = await this.getKit(project.kitId);

    await this.dataSource.transaction(async (manager) => {
      const newCount = scene.rerollCount + 1;
      const paid = creditsEnabled('commercials') && newCount > 1;
      if (paid) {
        // Mini-reserva do custo da cena (plano §8: 1º re-roll grátis).
        const amount = custoDaCena(scene);
        await this.credits.reserve(manager, userId, project.id, amount);
        await manager.increment(McProject, { id: project.id }, 'reservedCredits', amount);
      }

      await this.rearmScene(manager, scene, { bumpReroll: true });
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'scene',
        refId: scene.id,
        kind: 'reroll',
        fromStatus: scene.status,
        toStatus: McSceneStatus.PENDING,
        detail: { generation: scene.generation, rerollCount: newCount, paid },
      });

      const freshProject = await this.backToGenerating(manager, userId, project);
      await this.materializer.createSceneSteps(manager, freshProject, kit, scene);
      await this.refreshAssembly(manager, freshProject);
      await this.pipeline.enqueueReadySteps(manager, project.id);
    });
    return this.getScene(project.id, idx);
  }

  /**
   * PATCH /commercials/projects/:id/scenes/:idx/dialogue — regravar fala
   * (plano §6.3: invalida SÓ tts+lipsync; keyframe/video preservados via
   * skipped_cached apontando os assets atuais). Em storyboard_review edita só
   * o roteiro (as cenas ainda não existem — a aprovação materializa). Não
   * conta como re-roll (edição, sem cobrança na v0).
   */
  async updateDialogue(
    userId: string,
    projectId: string,
    idx: number,
    dialogue: string,
  ): Promise<McProject> {
    const project = await this.getOwnedProject(userId, projectId);
    this.assertProjectEditable(project, [
      McProjectStatus.STORYBOARD_REVIEW,
      McProjectStatus.NEEDS_ATTENTION,
      McProjectStatus.SUCCEEDED,
    ]);

    const moderation = await this.moderateOrFail(dialogue);
    if (moderation.flagged) {
      await this.auditBlockedModeration(userId, project.id, moderation);
      throw new UnprocessableEntityException({
        code: 'SCRIPT_MODERATION_BLOCKED',
        message: 'A nova fala foi bloqueada pela verificação de conteúdo. Ajuste o texto.',
      });
    }

    // Antes do gate: as cenas não existem — a edição vive só no roteiro.
    if (project.status === McProjectStatus.STORYBOARD_REVIEW) {
      const script = project.script;
      const scriptScene = script?.scenes.find((s) => s.idx === idx);
      if (!script || !scriptScene) throw new NotFoundException('Cena não encontrada no roteiro');
      await this.dataSource.transaction(async (manager) => {
        scriptScene.dialogue = dialogue;
        await manager.update(McProject, { id: project.id }, { script });
        await this.commercials.appendEvent(manager, {
          userId,
          refKind: 'project',
          refId: project.id,
          kind: 'dialogue_updated',
          detail: { idx, stage: 'storyboard_review' },
        });
      });
      return this.dataSource.getRepository(McProject).findOneByOrFail({ id: project.id });
    }

    await this.assertNotPaused(); // daqui em diante a edição dispara gasto novo
    const scene = await this.getScene(project.id, idx);
    if (scene.dialogue === null || scene.dialogue === '') {
      throw new UnprocessableEntityException({
        code: 'SCENE_NOT_SPOKEN',
        message: 'Esta cena não tem fala — a v0 só regrava falas de cenas faladas.',
      });
    }
    if (scene.status !== McSceneStatus.READY && scene.status !== McSceneStatus.FAILED) {
      throw new UnprocessableEntityException({
        code: 'SCENE_BUSY',
        message: `A cena está em '${scene.status}' — aguarde a geração terminar para regravar a fala.`,
      });
    }
    const kit = await this.getKit(project.kitId);

    await this.dataSource.transaction(async (manager) => {
      const fromStatus = scene.status;
      scene.dialogue = dialogue;
      await manager.update(McScene, { id: scene.id }, { dialogue });
      // Roteiro (fonte de verdade) acompanha a edição (§6.1).
      const script = project.script;
      const scriptScene = script?.scenes.find((s) => s.idx === idx);
      if (script && scriptScene) {
        scriptScene.dialogue = dialogue;
        await manager.update(McProject, { id: project.id }, { script });
      }

      await this.rearmScene(manager, scene, { bumpReroll: false });
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'scene',
        refId: scene.id,
        kind: 'dialogue_updated',
        fromStatus,
        toStatus: McSceneStatus.PENDING,
        detail: { generation: scene.generation },
      });

      const freshProject = await this.backToGenerating(manager, userId, project);
      await this.materializer.createSceneSteps(manager, freshProject, kit, scene);
      await this.refreshAssembly(manager, freshProject);
      await this.pipeline.enqueueReadySteps(manager, project.id);
    });
    return this.dataSource.getRepository(McProject).findOneByOrFail({ id: project.id });
  }

  /**
   * POST /commercials/projects/:id/cancel — CAS generating|needs_attention →
   * canceled, cancela steps pending/queued e cenas vivas, estorna o não
   * consumido (plano §6.7). Steps em execução no provider terminam sozinhos e
   * seus CAS de conclusão viram no-op (projeto já saiu de generating).
   */
  async cancelProject(userId: string, projectId: string): Promise<McProject> {
    const project = await this.getOwnedProject(userId, projectId);
    if (
      project.status !== McProjectStatus.GENERATING &&
      project.status !== McProjectStatus.NEEDS_ATTENTION
    ) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_NOT_CANCELABLE',
        message: `O projeto está em '${project.status}' — só gerações em andamento podem ser canceladas.`,
      });
    }
    await this.dataSource.transaction(async (manager) => {
      assertProjectTransition(project.status, McProjectStatus.CANCELED);
      const won = await this.transitions.casTransition(
        manager,
        McProject,
        project.id,
        project.status,
        McProjectStatus.CANCELED,
        { finishedAt: new Date() },
      );
      if (!won) {
        throw new UnprocessableEntityException({
          code: 'PROJECT_NOT_CANCELABLE',
          message: 'O projeto mudou de estado durante o cancelamento. Recarregue.',
        });
      }
      const canceledSteps = await this.pipeline.cancelIdleSteps(manager, project.id);
      await manager.update(
        McScene,
        { projectId: project.id, status: In([McSceneStatus.PENDING, McSceneStatus.RUNNING]) },
        { status: McSceneStatus.CANCELED },
      );
      const refunded = await this.credits.refundUnconsumed(
        manager,
        userId,
        project.id,
        project.reservedCredits,
        project.consumedCredits,
      );
      await this.pipeline.appendProjectTransition(
        manager,
        userId,
        project.id,
        project.status,
        McProjectStatus.CANCELED,
        { canceledSteps, refundedCredits: refunded },
      );
    });
    return this.dataSource.getRepository(McProject).findOneByOrFail({ id: project.id });
  }

  // ─────────────────────────────── internos ───────────────────────────────

  /** generation++ e re-arma a cena (ready|failed → pending), cancelando steps ociosos da geração velha. */
  private async rearmScene(
    manager: EntityManager,
    scene: McScene,
    opts: { bumpReroll: boolean },
  ): Promise<void> {
    assertSceneTransition(scene.status, McSceneStatus.PENDING);
    const patch: Record<string, unknown> = {
      generation: scene.generation + 1,
      videoAssetId: null,
      finalAssetId: null,
      errorCode: null,
      errorMessage: null,
      ...(opts.bumpReroll ? { rerollCount: scene.rerollCount + 1 } : {}),
    };
    const won = await this.transitions.casTransition(
      manager,
      McScene,
      scene.id,
      scene.status,
      McSceneStatus.PENDING,
      patch,
    );
    if (!won) {
      throw new UnprocessableEntityException({
        code: 'SCENE_STATE_CHANGED',
        message: 'A cena mudou de estado durante a operação. Recarregue e tente de novo.',
      });
    }
    await this.pipeline.cancelIdleSteps(manager, scene.projectId, scene.id);
    scene.generation += 1;
    if (opts.bumpReroll) scene.rerollCount += 1;
    scene.videoAssetId = null;
    scene.finalAssetId = null;
    scene.status = McSceneStatus.PENDING;
  }

  /** needs_attention|succeeded → generating (CAS); no-op se já está generating. */
  private async backToGenerating(
    manager: EntityManager,
    userId: string,
    project: McProject,
  ): Promise<McProject> {
    if (
      project.status === McProjectStatus.NEEDS_ATTENTION ||
      project.status === McProjectStatus.SUCCEEDED
    ) {
      assertProjectTransition(project.status, McProjectStatus.GENERATING);
      const won = await this.transitions.casTransition(
        manager,
        McProject,
        project.id,
        project.status,
        McProjectStatus.GENERATING,
        { errorCode: null, errorMessage: null, finishedAt: null },
      );
      if (won) {
        await this.pipeline.appendProjectTransition(
          manager,
          userId,
          project.id,
          project.status,
          McProjectStatus.GENERATING,
          {},
        );
      }
    }
    return manager.findOneByOrFail(McProject, { id: project.id });
  }

  /** Recria/atualiza o assembly pendente com o hash da composição corrente. */
  private async refreshAssembly(manager: EntityManager, project: McProject): Promise<void> {
    const scenes = await manager.find(McScene, { where: { projectId: project.id } });
    const live = scenes.filter((s) => s.status !== McSceneStatus.CANCELED);
    await this.materializer.ensureAssemblyStep(manager, project, live, {
      seal: project.script?.seal ?? null,
      endcard: project.script?.endcard ?? null,
    });
  }

  private assertProjectEditable(project: McProject, allowed: McProjectStatus[]): void {
    if (!allowed.includes(project.status)) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_STATE_INVALID',
        message: `Operação indisponível com o projeto em '${project.status}'.`,
      });
    }
  }

  private async assertNotPaused(): Promise<void> {
    if ((await this.settings.get<boolean>(MC_PAUSED_KEY)) === true) {
      throw new HttpException(
        {
          code: 'MC_PAUSED',
          message: 'Geração de comerciais pausada temporariamente pelo administrador',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async getOwnedProject(userId: string, id: string): Promise<McProject> {
    const project = await this.dataSource.getRepository(McProject).findOneBy({ id });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    if (project.userId !== userId) throw new ForbiddenException();
    return project;
  }

  private async getScene(projectId: string, idx: number): Promise<McScene> {
    const scene = await this.dataSource.getRepository(McScene).findOneBy({ projectId, idx });
    if (!scene) throw new NotFoundException('Cena não encontrada');
    return scene;
  }

  private async getKit(kitId: string): Promise<McCharacterKit> {
    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: kitId });
    if (!kit) throw new NotFoundException('Kit não encontrado');
    return kit;
  }

  /** Texto moderável do roteiro: ação (pt+en) + fala de cada cena + selos + cartela. */
  private scriptText(script: McScript): string {
    const parts = script.scenes.flatMap((s) => [
      s.actionPrompt,
      s.actionPromptEn ?? '',
      s.dialogue ?? '',
    ]);
    if (script.seal?.text) parts.push(script.seal.text);
    for (const product of script.seal?.products ?? []) parts.push(product.name);
    if (script.endcard?.storeName) parts.push(script.endcard.storeName);
    return parts.filter(Boolean).join('\n');
  }

  /** Moderação fail-closed (plano §6.8): indisponibilidade bloqueia com 503 acionável. */
  private async moderateOrFail(text: string): Promise<ModerationResult> {
    try {
      return await this.moderation.moderate({ text });
    } catch (err) {
      this.logger.error(`Moderação indisponível: ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        code: 'MODERATION_UNAVAILABLE',
        message: 'Não foi possível verificar o conteúdo agora. Tente novamente em instantes.',
      });
    }
  }

  private async auditBlockedModeration(
    userId: string,
    projectId: string,
    moderation: ModerationResult,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        McProject,
        { id: projectId },
        { moderation: this.moderationJson(moderation) },
      );
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'project',
        refId: projectId,
        kind: 'moderation_blocked',
        detail: { categories: moderation.categories },
      });
    });
  }

  /** jsonb auditável (plano §6.8) — raw só quando bloqueia (evita jsonb gigante no caminho feliz). */
  private moderationJson(result: ModerationResult): Record<string, unknown> {
    return {
      provider: 'omni-moderation-latest',
      flagged: result.flagged,
      categories: result.categories,
      ...(result.skipped ? { skipped: true } : {}),
      at: new Date().toISOString(),
      ...(result.flagged && result.raw ? { raw: result.raw } : {}),
    };
  }
}
