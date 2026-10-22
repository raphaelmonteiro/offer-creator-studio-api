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
import { MediaAssetsService } from '../../shared/media-assets/media-assets.service';
import { MC_EVENTS_CHANNEL } from '../../shared/events/animation-events.service';
import { AnimationQueueService, QUEUES } from '../../shared/queue/animation-queue.service';
import {
  RenderFormat,
  RenderFormatAvailability,
  renderMissingFor,
} from '../../shared/ffmpeg/render-preflight';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import {
  WORKER_HEARTBEAT_KEY,
  WorkerHeartbeat,
} from '../../shared/settings/worker-heartbeat.service';
import { TaskTransitionService } from '../../shared/state/task-transition.service';
import { computeInputHash, MC_BUILDER_VERSIONS } from './domain/input-hash';
import { MC_PROJECT_MINI_RESERVE_CREDITS, MC_STEP_CREDITS } from './domain/mc-pricing.config';
import {
  assertProjectTransition,
  assertStepTransition,
  McProjectStatus,
  McStepStatus,
} from './domain/mc-state-machines';
import { assertAspectSupportedForFormat } from './domain/mc-composition.config';
import {
  assertFormatEnabled,
  assertPipelineV2ForFormat,
  isPipelineV2RequiredSatisfied,
  parseMcFormats,
} from './domain/mc-pipeline.config';
import {
  MC_OFFER_CAROUSEL_MAX_OFFERS,
  MC_OFFER_CAROUSEL_MAX_SPEECH_S,
  MC_OFFER_CAROUSEL_MIN_OFFERS,
  MC_DEFAULT_PROJECT_CHANNEL,
  MC_DEFAULT_PROJECT_FORMAT,
  MC_DEFAULT_PROJECT_TIER,
  McAspectRatio,
  McProjectFormat,
  McSourceArtKind,
  McStepType,
  defaultMusicEnabled,
  resolveProjectOptions,
} from './domain/mc-types';
import { MC_EMPTY_QUALITY, MC_PIPELINE_LEGACY, MC_PIPELINE_V2 } from './domain/mc-quality';
import { availableProjectActions, McProjectAction } from './domain/mc-project-available-actions';
import {
  clipInspectionView,
  McClipInspectionView,
  McClipView,
  sceneClipView,
  stepClipView,
} from './domain/mc-clip-view';
import { randomUUID } from 'crypto';
import { McProjectLogoBox } from './domain/mc-logo-face';
import { McPieceDocument, pieceCanonicalHash } from './domain/mc-piece';
import { CreateProjectDto } from './dto/create-project.dto';

/**
 * Peça congelada que a ponte `POST projects/from-piece` entrega à criação
 * (change video-peca-configuravel): a referência, a cópia imutável do
 * descritor e, no modo rosto do logo, a caixa do logo já confirmada.
 */
export interface McProjectPieceInput {
  pieceId: string;
  pieceSnapshot: McPieceDocument;
  logoBox?: McProjectLogoBox | null;
}
import { McCharacterKit, McKitStatus } from './entities/mc-character-kit.entity';
import { McEvent } from './entities/mc-event.entity';
import { McProject } from './entities/mc-project.entity';
import { McScene } from './entities/mc-scene.entity';
import { McStep } from './entities/mc-step.entity';

/** Jobs de LLM são curtos — expiração de 120s por publish (plano §6.4: expireInSeconds POR FILA). */
const MC_LLM_EXPIRE_S = 120;

/**
 * Ativação do pipeline v2 por configuração/coorte (ADR-001 §5):
 * - MC_PIPELINE_V2=all      → todo projeto novo nasce no v2;
 * - MC_PIPELINE_V2=cohort   → só usuários listados em MC_PIPELINE_V2_USERS;
 * - qualquer outro valor    → legado (default).
 * A escolha é persistida no projeto; mudar a flag não altera projetos existentes.
 */
export function pipelineVersionForNewProject(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const mode = (env.MC_PIPELINE_V2 ?? 'off').toLowerCase();
  if (mode === 'all') return MC_PIPELINE_V2;
  if (mode === 'cohort') {
    const cohort = (env.MC_PIPELINE_V2_USERS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    return cohort.includes(userId) ? MC_PIPELINE_V2 : MC_PIPELINE_LEGACY;
  }
  return MC_PIPELINE_LEGACY;
}

/**
 * Kill-switch em banco (plano §6.7): 'mc_paused' = true pausa a criação de
 * comerciais sem redeploy. Gravada pela rota admin POST /commercials/admin/pause
 * e checada a cada enqueue via SystemSettingsService.get (cache de 10s).
 */
export const MC_PAUSED_KEY = 'mc_paused';

/**
 * `GET /commercials/config`: o que o front pode oferecer ANTES de criar —
 * formatos admitidos neste ambiente e a disponibilidade de render por formato
 * segundo o último preflight do worker (`null` = worker ainda sem preflight).
 */
export interface McCommercialsConfig {
  formats: Record<McProjectFormat, boolean>;
  render: Record<RenderFormat, RenderFormatAvailability> | null;
}

/**
 * Admissão do F2 "ofertas em sequência" (spec video-offer-carousel "Ofertas do
 * projeto", tarefa 6.6): 3 a 6 ofertas, todas com foto — regra de negócio
 * (422) ANTES de qualquer gasto; a ponte arte → projeto já recusa na forma
 * (400) e resolve fotos faltantes pelo catálogo/galeria.
 */
export const McCommercialsF2Gate = {
  assertOffers(products: Array<{ name: string; imageUrl?: string | null }>): void {
    if (
      products.length < MC_OFFER_CAROUSEL_MIN_OFFERS ||
      products.length > MC_OFFER_CAROUSEL_MAX_OFFERS
    ) {
      throw new HttpException(
        {
          code: 'OFFER_SELECTION_INVALID',
          message:
            products.length < MC_OFFER_CAROUSEL_MIN_OFFERS
              ? `"Ofertas em sequência" pede no mínimo ${MC_OFFER_CAROUSEL_MIN_OFFERS} ofertas.`
              : `"Ofertas em sequência" aceita no máximo ${MC_OFFER_CAROUSEL_MAX_OFFERS} ofertas ` +
                `(o vídeo tem até ${MC_OFFER_CAROUSEL_MAX_SPEECH_S} s de fala).`,
          details: {
            min: MC_OFFER_CAROUSEL_MIN_OFFERS,
            max: MC_OFFER_CAROUSEL_MAX_OFFERS,
            received: products.length,
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const withoutImage = products.filter((p) => !p.imageUrl?.trim());
    if (withoutImage.length > 0) {
      throw new HttpException(
        {
          code: 'OFFER_IMAGE_REQUIRED',
          message:
            'Toda oferta de "ofertas em sequência" precisa de foto. Escolha uma do catálogo ou ' +
            `da galeria para: ${withoutImage.map((p) => p.name).join(', ')}`,
          details: { offers: withoutImage.map((p) => ({ name: p.name })) },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  },
};

@Injectable()
export class CommercialsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly queue: AnimationQueueService,
    private readonly settings: SystemSettingsService,
    private readonly credits: CreditsService,
    private readonly mediaAssets: MediaAssetsService,
  ) {}

  /**
   * Gate de admissão por formato e versão (change video-formatos-personagem,
   * D6/D13), reutilizado por `createProject`, `createFromArt` e pela
   * duplicação: 422 FORMAT_NOT_ENABLED quando o formato novo está fora de
   * `MC_FORMATS`; 422 PIPELINE_V2_REQUIRED quando F1/F2 nascem sem
   * `MC_PIPELINE_V2=all`. Devolve o `pipelineVersion` a gravar: os formatos
   * novos são SEMPRE v2 (explícito, sem passar pela coorte); `scenes` segue a
   * configuração/coorte.
   */
  admitProjectFormat(userId: string, format: McProjectFormat): number {
    assertFormatEnabled(format);
    assertPipelineV2ForFormat(format);
    return format === MC_DEFAULT_PROJECT_FORMAT
      ? pipelineVersionForNewProject(userId)
      : MC_PIPELINE_V2;
  }

  /**
   * Arte de fundo do F1/F2 (D9): precisa ser um asset `video_art` DO USUÁRIO
   * com arquivo (404/403 vêm do `findOwned`; kind/arquivo errados → 422
   * BACKGROUND_ART_INVALID). Devolve o asset para quem precisar das dimensões.
   */
  async assertBackgroundArt(userId: string, assetId: string): Promise<AnimationAsset> {
    const asset = await this.mediaAssets.findOwned(userId, assetId);
    if (asset.kind !== 'video_art' || !asset.fileUrl) {
      throw new HttpException(
        {
          code: 'BACKGROUND_ART_INVALID',
          message: 'A arte de fundo precisa ser uma arte enviada por POST /commercials/art.',
          details: { assetId, kind: asset.kind },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return asset;
  }

  /**
   * Gate de preflight (spec video-composition-render, "Preflight por formato"):
   * lê o heartbeat FRESCO do worker e recusa com 422 RENDER_UNAVAILABLE quando
   * o último preflight diz que falta requisito DESTE formato. Preflight
   * desconhecido (worker ainda sem batimento) ou tabela indisponível não
   * bloqueiam: o bloqueio é só por falta comprovada.
   */
  async assertRenderAvailable(format: McProjectFormat): Promise<void> {
    let heartbeat: WorkerHeartbeat | null = null;
    try {
      heartbeat = await this.settings.getFresh<WorkerHeartbeat>(WORKER_HEARTBEAT_KEY);
    } catch {
      return;
    }
    const missing = renderMissingFor(format, heartbeat?.render);
    if (!missing || missing.length === 0) return;
    throw new HttpException(
      {
        code: 'RENDER_UNAVAILABLE',
        message:
          `O worker não tem o necessário para renderizar o formato "${format}": ` +
          missing.join(', '),
        details: {
          format,
          missing,
          details: heartbeat?.render?.details ?? {},
          checkedAt: heartbeat?.render?.checkedAt ?? null,
        },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  /**
   * Configuração pública do módulo para a UI (spec "Gate por formato"): um
   * formato novo está habilitado quando está em `MC_FORMATS` E o executor v2
   * está em `all` (senão a criação responderia FORMAT_NOT_ENABLED ou
   * PIPELINE_V2_REQUIRED); `scenes` sempre. `render` espelha
   * `worker.render.formats` do heartbeat FRESCO — heartbeat ausente ou
   * ilegível vira `null` (desconhecido; os gates não bloqueiam nesse caso).
   */
  async getConfig(env: NodeJS.ProcessEnv = process.env): Promise<McCommercialsConfig> {
    const enabled = parseMcFormats(env);
    const admitted = (format: McProjectFormat) =>
      enabled.includes(format) && isPipelineV2RequiredSatisfied(format, env);
    let heartbeat: WorkerHeartbeat | null = null;
    try {
      heartbeat = await this.settings.getFresh<WorkerHeartbeat>(WORKER_HEARTBEAT_KEY);
    } catch {
      heartbeat = null;
    }
    return {
      formats: {
        scenes: true,
        talking_art: admitted('talking_art'),
        offer_carousel: admitted('offer_carousel'),
        offer_piece: admitted('offer_piece'),
      },
      render: heartbeat?.render?.formats ?? null,
    };
  }

  /**
   * Criação do projeto (fatia vertical da Fase 0): valida ownership do kit,
   * cria o projeto em 'draft', CAS draft → scripting, cria o step 'script'
   * (com inputHash canônico), enfileira em mc.llm e emite evento + pg_notify —
   * TUDO NA MESMA TRANSAÇÃO (padrão do animations; pg-boss é Postgres).
   */
  async createProject(
    userId: string,
    dto: CreateProjectDto,
    piece?: McProjectPieceInput,
  ): Promise<McProject> {
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

    // Formato do DTO (default 'scenes', F3). Regras de negócio ANTES de qualquer
    // leitura ou gasto (D13: forma → 400 pelo pipe; regra → 422 com código):
    // 1) `scenes` monta em 720p e NÃO aceita 4:5 (D12) — os formatos novos
    //    aceitam os quatro aspectos; 2) formato novo fora de MC_FORMATS →
    //    FORMAT_NOT_ENABLED; sem MC_PIPELINE_V2=all → PIPELINE_V2_REQUIRED.
    const format: McProjectFormat = dto.format ?? MC_DEFAULT_PROJECT_FORMAT;
    // Contrato v1-B1: aspectRatio default 9:16 — o front pode omitir.
    const aspectRatio: McAspectRatio = dto.aspectRatio ?? '9:16';
    assertAspectSupportedForFormat(format, aspectRatio);
    const pipelineVersion = this.admitProjectFormat(userId, format);

    // Preflight de render (design D14): recusa antes de qualquer gasto quando o
    // worker publicou que falta requisito do formato. O formato de cenas (F3)
    // NÃO é gated — "F3 não muda nesta change" (proposal); o health continua
    // informando o estado dele.
    if (format !== MC_DEFAULT_PROJECT_FORMAT) await this.assertRenderAvailable(format);

    // F1 exige a arte de fundo (asset `video_art` do usuário, D9). A forma
    // (uuid obrigatório no formato) já passou pelo DTO; aqui é a regra.
    if (format === 'talking_art' && !dto.backgroundArtAssetId) {
      throw new HttpException(
        {
          code: 'BACKGROUND_ART_REQUIRED',
          message: 'O formato "arte que fala" precisa da arte de fundo (backgroundArtAssetId).',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (dto.backgroundArtAssetId) await this.assertBackgroundArt(userId, dto.backgroundArtAssetId);
    if (format === 'offer_carousel') McCommercialsF2Gate.assertOffers(dto.products ?? []);
    // Peça de ofertas: só nasce pela ponte `POST projects/from-piece`, que
    // valida a peça e a congela (`pieceSnapshot`); sem ela não há quadro.
    if (format === 'offer_piece' && !piece) {
      throw new HttpException(
        {
          code: 'PIECE_REQUIRED',
          message:
            'O formato "peça de ofertas" nasce de uma peça montada no editor ' +
            '(POST /commercials/projects/from-piece).',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
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
    // Peça de ofertas: o tile de fala É o personagem dentro da peça — a
    // produção recusaria depois (KIT_TILE_MISSING); aqui recusa antes de gastar.
    if (format === 'offer_piece' && !kit.tileAssetId) {
      throw new HttpException(
        {
          code: 'KIT_TILE_MISSING',
          message:
            'Este kit foi aprovado antes do recorte de fala do personagem. ' +
            'Para a peça de ofertas, crie um kit novo.',
          details: { kitId: kit.id },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // CRÉDITOS (plano §6.7): mini-reserva fixa de 10 cr na criação; a
      // reserva PRINCIPAL (custoDoProjeto do roteiro) acontece na aprovação
      // do storyboard. Com creditsEnabled('commercials') off (default até o
      // go-live, flag MC_CREDITS_ENABLED) a reserva é 0 e nada vai ao ledger.
      const reservedCredits = creditsEnabled('commercials') ? MC_PROJECT_MINI_RESERVE_CREDITS : 0;

      // Contrato v1-B1: música/legendas default on; produtos (máx. 6) chegam
      // prontos do front (name+price) e viram os selos determinísticos do
      // roteiro/montagem (plano §5.4).
      // Executor congelado na criação (ADR-001 §5): configuração/coorte decide
      // no F3; os formatos novos são sempre v2 (`admitProjectFormat`);
      // desligar a flag depois NÃO muda projetos em andamento.
      // Trilha: F3 ligada por padrão (v1-B1); F1/F2 desligada por padrão — a
      // trilha é paga (ElevenLabs Music) e só entra por escolha explícita.
      const options = resolveProjectOptions({
        musicEnabled: dto.musicEnabled ?? defaultMusicEnabled(format),
        captionsEnabled: dto.captionsEnabled,
        lowerThirdBlur: dto.lowerThirdBlur,
        // v2: chave estável por produto desde a criação (snapshot do roteiro)
        products:
          pipelineVersion === MC_PIPELINE_V2
            ? (dto.products ?? []).map((p) => ({ ...p, id: randomUUID() }))
            : dto.products,
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
        pipelineVersion,
        // Formato/tier/canal explícitos (design D6/D13): o F3 é 'scenes' +
        // 'economico' (rótulo, sem troca de motor) — os mesmos defaults da
        // migration; F1/F2 carregam arte, preset, caixa do logo e origem (D9).
        format,
        tier: dto.tier ?? MC_DEFAULT_PROJECT_TIER,
        channel: dto.channel ?? MC_DEFAULT_PROJECT_CHANNEL,
        backgroundArtAssetId: dto.backgroundArtAssetId ?? null,
        layoutPreset: dto.layoutPreset ?? null,
        // Peça de ofertas: a caixa do logo vem do bloco da logo na peça (já confirmada).
        logoBox: piece?.logoBox ?? (dto.logoBox ? { ...dto.logoBox } : null),
        sourceArt: dto.sourceArt ? { ...dto.sourceArt } : null,
        pieceId: piece?.pieceId ?? null,
        pieceSnapshot: piece?.pieceSnapshot ?? null,
        revision: 0,
        // F1/F2 gravam `quality` vazio EXPLICITAMENTE (D6), como o v2 do F3.
        quality: pipelineVersion === MC_PIPELINE_V2 ? { ...MC_EMPTY_QUALITY } : null,
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
        // Formatos novos (D6): o diretor F1/F2 é outro — o roteiro do F3 com o
        // mesmo briefing nunca serve. Ausente no F3 para preservar os hashes.
        ...(format !== MC_DEFAULT_PROJECT_FORMAT
          ? { format, backgroundArtAssetId: dto.backgroundArtAssetId ?? null }
          : {}),
        // Peça de ofertas: mudar a peça (itens falados, janela, painel) muda o roteiro.
        ...(piece ? { pieceHash: pieceCanonicalHash(piece.pieceSnapshot) } : {}),
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
        // job na MESMA transação do step de roteiro (só visível ao worker no commit)
        { expireInSeconds: MC_LLM_EXPIRE_S, manager },
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

  /**
   * Lista do usuário (100 mais recentes). `filter.sourceKind`/`sourceId`
   * restringem aos projetos nascidos de uma arte (ponte D9, tarefa 5.5):
   * "vídeos desta arte" — o filtro lê o jsonb `sourceArt`.
   */
  async findAllProjects(
    userId: string,
    filter?: { sourceKind?: McSourceArtKind; sourceId?: string },
  ): Promise<Array<McProject & { finalUrl: string | null; posterUrl: string | null }>> {
    const repo = this.dataSource.getRepository(McProject);
    let projects: McProject[];
    if (filter?.sourceKind || filter?.sourceId) {
      const qb = repo.createQueryBuilder('p').where('p."userId" = :userId', { userId });
      if (filter.sourceKind) {
        qb.andWhere(`p."sourceArt"->>'kind' = :sourceKind`, { sourceKind: filter.sourceKind });
      }
      if (filter.sourceId) {
        qb.andWhere(`p."sourceArt"->>'id' = :sourceId`, { sourceId: filter.sourceId });
      }
      projects = await qb.orderBy('p."createdAt"', 'DESC').take(100).getMany();
    } else {
      projects = await repo.find({
        where: { userId },
        order: { createdAt: 'DESC' },
        take: 100,
      });
    }
    const urls = await this.resolveAssetUrls(projects.map((p) => p.finalAssetId));
    return projects.map((p) => ({
      ...p,
      finalUrl: (p.finalAssetId && urls.get(p.finalAssetId)?.fileUrl) || null,
      posterUrl: (p.finalAssetId && urls.get(p.finalAssetId)?.posterUrl) || null,
    }));
  }

  /**
   * Projeto + cenas + steps (visão completa para a UI de acompanhamento).
   * Pipeline v2: cada cena expõe também `audioUrl`/`videoUrl` (assets
   * selecionados) e cada step `outputUrl` (alternativas de prévia por
   * tentativa), além de `revision`, `pipelineVersion` e `quality` (manifestos,
   * aprovação, orçamentos e timeline renderizada) que já vêm da entidade.
   */
  async findOneProject(
    userId: string,
    id: string,
  ): Promise<
    McProject & {
      finalUrl: string | null;
      posterUrl: string | null;
      /** v2: URL da última entrega válida preservada em `quality.lastDelivery` (revisão anterior). */
      lastDeliveryUrl: string | null;
      /**
       * `engine`/`resolution` (7.2): motor e medidas do clipe final da cena;
       * `inspection` (3.7): veredito da inspeção do clipe para a revisão sinalizar.
       */
      scenes: Array<
        McScene &
          McClipView & {
            keyframeUrl: string | null;
            finalUrl: string | null;
            audioUrl: string | null;
            videoUrl: string | null;
            inspection: McClipInspectionView | null;
          }
      >;
      /** `engine`/`resolution` (7.2): só em steps de motor (talk/lipsync/video); null nos demais. */
      steps: Array<
        McStep & McClipView & { outputUrl: string | null; outputPosterUrl: string | null }
      >;
      /** Ações oferecidas à UI (ex.: `refazer`, `duplicar_como_economico` após falha do motor premium). */
      availableActions: McProjectAction[];
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
    const lastDeliveryAssetId = project.quality?.lastDelivery?.finalAssetId ?? null;
    const urls = await this.resolveAssetUrls([
      project.finalAssetId,
      lastDeliveryAssetId,
      ...scenes.flatMap((s) => [s.keyframeAssetId, s.finalAssetId, s.audioAssetId, s.videoAssetId]),
      ...steps.map((s) => s.outputAssetId),
    ]);
    const url = (assetId: string | null | undefined) =>
      (assetId && urls.get(assetId)?.fileUrl) || null;
    return {
      ...project,
      finalUrl: url(project.finalAssetId),
      posterUrl: (project.finalAssetId && urls.get(project.finalAssetId)?.posterUrl) || null,
      lastDeliveryUrl: url(lastDeliveryAssetId),
      availableActions: availableProjectActions(project, steps),
      scenes: scenes.map((s) => ({
        ...s,
        keyframeUrl: url(s.keyframeAssetId),
        finalUrl: url(s.finalAssetId),
        audioUrl: url(s.audioAssetId),
        videoUrl: url(s.videoAssetId),
        ...sceneClipView(s.finalAssetId ? urls.get(s.finalAssetId) : null),
        inspection: clipInspectionView(s.finalAssetId ? urls.get(s.finalAssetId) : null),
      })),
      steps: steps.map((s) => ({
        ...s,
        outputUrl: url(s.outputAssetId),
        outputPosterUrl: (s.outputAssetId && urls.get(s.outputAssetId)?.posterUrl) || null,
        ...stepClipView(s, s.outputAssetId ? urls.get(s.outputAssetId) : null),
      })),
    };
  }

  /**
   * Resolve fileUrl/posterUrl de um conjunto de asset ids (ignora nulos e
   * ausentes), com tipo/medidas/metadata para a visão do clipe (motor e
   * resolução, 7.2).
   */
  private async resolveAssetUrls(ids: Array<string | null | undefined>): Promise<
    Map<
      string,
      {
        fileUrl: string | null;
        posterUrl: string | null;
        kind: string;
        mimeType: string | null;
        width: number | null;
        height: number | null;
        metadata: Record<string, unknown> | null;
      }
    >
  > {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (unique.length === 0) return new Map();
    const assets = await this.dataSource
      .getRepository(AnimationAsset)
      .find({ where: { id: In(unique) } });
    return new Map(
      assets.map((a) => [
        a.id,
        {
          fileUrl: a.fileUrl ?? null,
          posterUrl: a.posterUrl ?? null,
          kind: a.kind,
          mimeType: a.mimeType ?? null,
          width: a.width ?? null,
          height: a.height ?? null,
          metadata: a.metadata ?? null,
        },
      ]),
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
