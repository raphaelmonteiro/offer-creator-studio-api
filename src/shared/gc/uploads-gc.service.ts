import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, LessThan } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AnimationAsset } from '../media-assets/animation-asset.entity';
import {
  CommercialsGcAsset,
  CommercialsGcContext,
  COMMERCIALS_GC_DELIVERY_KINDS,
  DELIVERY_RETENTION_MS,
  PIECE_BACKGROUND_RETENTION_MS,
  EXPORT_RETENTION_MS,
  GcReason,
  GcSelection,
  KIT_CANDIDATE_RETENTION_MS,
  SOFT_DELETED_RETENTION_MS,
  SUPERSEDED_TILE_GRACE_MS,
  VIDEO_ART_RETENTION_MS,
  selectCommercialsGarbage,
  selectGarbage,
} from './uploads-gc.rules';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Espera pós-boot antes da primeira varredura (não competir com o start dos consumers). */
const INITIAL_DELAY_MS = 5 * 60 * 1000;

export interface GcRunSummary {
  dryRun: boolean;
  /** Totais das duas varreduras (animations + commercials). */
  scanned: number;
  selectedAssets: number;
  deletedFiles: number;
  skippedFiles: number;
  /** Assets selecionados por motivo (inclui as regras de comerciais, 8.2). */
  byReason: Partial<Record<GcReason, number>>;
  /** Recorte da varredura de /uploads/commercials/ (8.2). */
  commercials: { scanned: number; selectedAssets: number };
}

const EMPTY_COMMERCIALS_CONTEXT: CommercialsGcContext = {
  kits: [],
  candidates: [],
  projects: [],
  deliveries: [],
  stepReferencedAssetIds: [],
  referencedPieceBackgroundIds: [],
};

const unique = (values: Array<string | null | undefined>): string[] => [
  ...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0)),
];

/**
 * GC diário de uploads/animations (TDD ADR-05, plano-comerciais §11).
 *
 * Mecanismo: `setInterval` de 24h DENTRO do worker (WORKER_ONLY=true) — a
 * opção mais simples entre as duas do plano. Uma fila pg-boss agendada exigiria
 * suporte a cron no QueuePort e uma fila extra só para isso; como o worker é um
 * único processo PM2 e apagar arquivo já apagado é no-op, o timer em processo
 * dá a mesma garantia com muito menos peças. Se o worker escalar horizontal,
 * migrar para `boss.schedule` é trivial (a seleção já é função pura).
 *
 * Segurança nesta fase: DRY-RUN por padrão — só apaga de verdade com
 * `GC_DRY_RUN=false` explícito no ambiente.
 *
 * Comerciais (change video-formatos-personagem, 8.2): a mesma varredura
 * avalia /uploads/commercials/ com retenção por tipo (`selectCommercialsGarbage`).
 * As referências vêm das tabelas `mc_*` por SQL cru — o shared não importa
 * entidades de módulos. Em execução real, o asset recolhido é soft-deletado
 * e marcado (`metadata.gc.collectedAt`) para não ser reavaliado.
 */
@Injectable()
export class UploadsGcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadsGcService.name);
  private initialTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKER_ONLY !== 'true') return; // GC roda apenas no worker
    // roda se QUALQUER um dos módulos com uploads coletáveis estiver ligado
    if (
      this.config.get('ANIMATIONS_ENABLED') === 'false' &&
      this.config.get('MC_ENABLED') !== 'true'
    ) {
      return;
    }
    this.initialTimer = setTimeout(() => void this.safeRun(), INITIAL_DELAY_MS);
    this.initialTimer.unref();
    this.timer = setInterval(() => void this.safeRun(), DAY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
  }

  private async safeRun(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`GC de uploads falhou: ${(err as Error).message}`);
    }
  }

  /** Uma varredura completa. Exposto para disparo manual/testes. */
  async runOnce(now = new Date()): Promise<GcRunSummary> {
    // default de segurança nesta fase: só apaga com GC_DRY_RUN=false explícito
    const dryRun = process.env.GC_DRY_RUN !== 'false';
    const softDeleteCutoff = new Date(now.getTime() - SOFT_DELETED_RETENTION_MS);
    const exportCutoff = new Date(now.getTime() - EXPORT_RETENTION_MS);

    const candidates = await this.dataSource.getRepository(AnimationAsset).find({
      withDeleted: true, // a regra principal é justamente sobre soft-deletados
      where: [
        { deletedAt: LessThan(softDeleteCutoff) },
        { kind: 'export', createdAt: LessThan(exportCutoff) },
      ],
    });
    const selections = selectGarbage(candidates, now);

    // /uploads/commercials/ (8.2): retenção por tipo, referências das tabelas mc_*.
    // Falha aqui não derruba a varredura de animations (isolada e registrada).
    let commercialsCandidates: CommercialsGcAsset[] = [];
    let commercialsSelections: GcSelection[] = [];
    try {
      commercialsCandidates = await this.findCommercialsCandidates(now);
      commercialsSelections = selectCommercialsGarbage(
        commercialsCandidates,
        await this.commercialsContext(commercialsCandidates),
        now,
      );
    } catch (err) {
      this.logger.error(`GC de comerciais falhou na seleção: ${(err as Error).message}`);
      commercialsCandidates = [];
      commercialsSelections = [];
    }

    const animationsResult = await this.applySelections(selections, dryRun);
    const commercialsResult = await this.applySelections(commercialsSelections, dryRun);
    if (!dryRun) await this.markCollected(commercialsSelections, now);

    const byReason: Partial<Record<GcReason, number>> = {};
    for (const selection of [...selections, ...commercialsSelections]) {
      byReason[selection.reason] = (byReason[selection.reason] ?? 0) + 1;
    }
    const summary: GcRunSummary = {
      dryRun,
      scanned: candidates.length + commercialsCandidates.length,
      selectedAssets: selections.length + commercialsSelections.length,
      deletedFiles: animationsResult.deleted + commercialsResult.deleted,
      skippedFiles: animationsResult.skipped + commercialsResult.skipped,
      byReason,
      commercials: {
        scanned: commercialsCandidates.length,
        selectedAssets: commercialsSelections.length,
      },
    };
    this.logger.log(`GC de uploads: ${JSON.stringify(summary)}`);
    return summary;
  }

  /** Apaga (ou só registra, em dry-run) os arquivos selecionados, com guarda de caminho. */
  private async applySelections(
    selections: GcSelection[],
    dryRun: boolean,
  ): Promise<{ deleted: number; skipped: number }> {
    const uploadsDir = path.resolve(this.config.get('UPLOAD_DEST', './uploads'));
    let deleted = 0;
    let skipped = 0;
    for (const selection of selections) {
      for (const url of selection.files) {
        const absolute = path.resolve(uploadsDir, url.replace(/^\/uploads\//, ''));
        if (!absolute.startsWith(uploadsDir + path.sep)) {
          skipped += 1;
          this.logger.warn(`GC ignorou caminho fora de uploads: ${url}`);
          continue;
        }
        if (!dryRun) {
          try {
            await fs.unlink(absolute);
          } catch (err) {
            skipped += 1;
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              this.logger.warn(`GC não conseguiu apagar ${url}: ${(err as Error).message}`);
            }
            continue;
          }
        }
        deleted += 1;
        // log estruturado do que foi (ou seria) apagado
        this.logger.log(
          JSON.stringify({
            gc: 'uploads',
            action: dryRun ? 'would_delete' : 'deleted',
            assetId: selection.assetId,
            reason: selection.reason,
            file: url,
          }),
        );
      }
    }
    return { deleted, skipped };
  }

  /** Candidatos de comerciais por tipo, já filtrados pela idade mínima de cada regra. */
  private async findCommercialsCandidates(now: Date): Promise<CommercialsGcAsset[]> {
    const before = (ms: number) => LessThan(new Date(now.getTime() - ms));
    const rows = await this.dataSource.getRepository(AnimationAsset).find({
      withDeleted: true, // tile descartado é soft-deletado na troca de identidade
      where: [
        { kind: 'kit_candidate', createdAt: before(KIT_CANDIDATE_RETENTION_MS) },
        { kind: 'kit_tile', createdAt: before(SUPERSEDED_TILE_GRACE_MS) },
        {
          kind: In([...COMMERCIALS_GC_DELIVERY_KINDS]),
          createdAt: before(DELIVERY_RETENTION_MS),
        },
        { kind: 'video_art', createdAt: before(VIDEO_ART_RETENTION_MS) },
        { kind: 'piece_background', createdAt: before(PIECE_BACKGROUND_RETENTION_MS) },
      ],
    });
    return rows.map((a) => ({ ...a, metadata: a.metadata ?? null }));
  }

  /**
   * Referências dos candidatos nas tabelas `mc_*` (SQL cru, ids comparados
   * como texto): kits que apontam para os assets ou geraram os candidatos,
   * escolhas de candidatos, projetos (entregas e arte de fundo), TODAS as
   * entregas dos projetos envolvidos (ranking das 3 mais recentes) e tiles
   * citados por snapshots de steps.
   */
  private async commercialsContext(assets: CommercialsGcAsset[]): Promise<CommercialsGcContext> {
    if (assets.length === 0) return EMPTY_COMMERCIALS_CONTEXT;
    const ids = assets.map((a) => a.id);
    const meta = (a: CommercialsGcAsset, key: string) => {
      const value = a.metadata?.[key];
      return typeof value === 'string' ? value : null;
    };
    const kitIds = unique(assets.map((a) => meta(a, 'kitId')));
    const deliveryKinds: string[] = [...COMMERCIALS_GC_DELIVERY_KINDS];
    const backgroundIds = assets.filter((a) => a.kind === 'piece_background').map((a) => a.id);
    const projectIds = unique(
      assets.filter((a) => deliveryKinds.includes(a.kind)).map((a) => meta(a, 'projectId')),
    );
    const tileIds = assets.filter((a) => a.kind === 'kit_tile').map((a) => a.id);

    const kits = (await this.dataSource.query(
      `SELECT id::text AS id,
              "candidateRoundId"::text AS "candidateRoundId",
              "identityAssetId"::text AS "identityAssetId",
              "tileAssetId"::text AS "tileAssetId",
              "cutoutAssetId"::text AS "cutoutAssetId",
              "referenceAssetIds"::text[] AS "referenceAssetIds"
         FROM mc_character_kits
        WHERE id::text = ANY($1::text[])
           OR "identityAssetId"::text = ANY($2::text[])
           OR "tileAssetId"::text = ANY($2::text[])
           OR "cutoutAssetId"::text = ANY($2::text[])
           OR "referenceAssetIds"::text[] && $2::text[]`,
      [kitIds, ids],
    )) as CommercialsGcContext['kits'];
    const candidates = (await this.dataSource.query(
      `SELECT "assetId"::text AS "assetId", "kitId"::text AS "kitId",
              "roundId"::text AS "roundId", chosen
         FROM mc_kit_candidates
        WHERE "assetId"::text = ANY($1::text[])`,
      [ids],
    )) as CommercialsGcContext['candidates'];
    const projects = (await this.dataSource.query(
      `SELECT id::text AS id,
              "finalAssetId"::text AS "finalAssetId",
              quality->'lastDelivery'->>'finalAssetId' AS "lastDeliveryAssetId",
              "backgroundArtAssetId"::text AS "backgroundArtAssetId"
         FROM mc_projects
        WHERE id::text = ANY($1::text[])
           OR "backgroundArtAssetId"::text = ANY($2::text[])
           OR "finalAssetId"::text = ANY($2::text[])
           OR quality->'lastDelivery'->>'finalAssetId' = ANY($2::text[])`,
      [projectIds, ids],
    )) as CommercialsGcContext['projects'];
    const deliveryRows = projectIds.length
      ? ((await this.dataSource.query(
          `SELECT id::text AS id, kind, metadata->>'projectId' AS "projectId", "createdAt",
                  metadata->>'version' AS version,
                  metadata->>'composedAssetId' AS "composedAssetId"
             FROM animation_assets
            WHERE kind = ANY($2::text[])
              AND metadata->>'projectId' = ANY($1::text[])
              AND metadata->'gc' IS NULL`,
          [projectIds, deliveryKinds],
        )) as Array<{
          id: string;
          kind: string;
          projectId: string;
          createdAt: Date | string;
          version: string | null;
          composedAssetId: string | null;
        }>)
      : [];
    const stepRows = tileIds.length
      ? ((await this.dataSource.query(
          `SELECT DISTINCT "inputSnapshot"->>'tileAssetId' AS id
             FROM mc_steps
            WHERE "inputSnapshot"->>'tileAssetId' = ANY($1::text[])`,
          [tileIds],
        )) as Array<{ id: string }>)
      : [];
    // Fundos de peça (6.6): referenciados pela URL em `mc_pieces.document` ou no
    // `pieceSnapshot` congelado de um projeto.
    const backgroundRows = backgroundIds.length
      ? ((await this.dataSource.query(
          `SELECT a.id::text AS id
             FROM animation_assets a
            WHERE a.id::text = ANY($1::text[])
              AND (
                EXISTS (SELECT 1 FROM mc_pieces p
                         WHERE p.document->'background'->>'imageUrl' = a."fileUrl")
                OR EXISTS (SELECT 1 FROM mc_projects pr
                         WHERE pr."pieceSnapshot"->'background'->>'imageUrl' = a."fileUrl")
              )`,
          [backgroundIds],
        )) as Array<{ id: string }>)
      : [];
    return {
      referencedPieceBackgroundIds: backgroundRows.map((r) => r.id),
      kits,
      candidates,
      projects,
      deliveries: deliveryRows.map((d) => ({
        id: d.id,
        kind: d.kind,
        projectId: d.projectId,
        createdAt: new Date(d.createdAt),
        version: d.version != null && Number.isFinite(Number(d.version)) ? Number(d.version) : null,
        composedAssetId: d.composedAssetId ?? null,
      })),
      stepReferencedAssetIds: stepRows.map((r) => r.id),
    };
  }

  /**
   * Execução real: o asset de comerciais recolhido é soft-deletado (a API
   * passa a responder 404 em vez de servir um arquivo ausente) e marcado em
   * `metadata.gc` para não voltar às próximas varreduras.
   */
  private async markCollected(selections: GcSelection[], now: Date): Promise<void> {
    for (const selection of selections) {
      await this.dataSource.query(
        `UPDATE animation_assets
            SET "deletedAt" = COALESCE("deletedAt", $2::timestamptz),
                metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('gc', jsonb_build_object('collectedAt', $3::text, 'reason', $4::text))
          WHERE id = $1`,
        [selection.assetId, now, now.toISOString(), selection.reason],
      );
    }
  }
}
