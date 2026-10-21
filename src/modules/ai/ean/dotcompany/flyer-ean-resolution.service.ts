import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  MatchV2Result,
  ProductImageMatchV2Service,
  ProductMatchInputV2,
  ScoredCandidateV2,
} from '../../metadata/product-image-match-v2.service';
import { classifyEan, DotcompanyLookupService } from './dotcompany-lookup.service';
import { DotcompanyPhotoImporter } from './dotcompany-photo.importer';
import { EanImportJobService } from './ean-import-job.service';
import { EanImportRunner } from './ean-import.runner';
import { productAliasKey } from '../../../gallery/product-alias';

/** Mesmo patamar de revisão do match-v2: abaixo disso a "parecida" não vale mostrar. */
const SIMILAR_MIN_SCORE = 0.5;
const SIMILAR_TOP_N = 3;
/** Fotos escolhidas antes para o mesmo nome que vão para a revisão quando há mais de uma. */
const ALIAS_REVIEW_TOP_N = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Motivo que marca, no match e nas candidatas, a foto já escolhida antes para este nome. */
export const ALIAS_REASON = 'nome escolhido antes';

export type EanResolutionStatus =
  | 'gallery'
  | 'dotcompany'
  | 'not_found'
  | 'invalid'
  | 'budget_blocked'
  | 'pending';

export interface EanStatusEntry {
  productId: string;
  ean: string;
  status: EanResolutionStatus;
  reason?: string | null;
}

export interface PhotoOption {
  imageId: string;
  url: string;
  thumbnailUrl: string | null;
  filename: string;
  /**
   * `same-ean`: outra foto com o mesmo EAN; `same-name`: outra foto já escolhida
   * antes para este nome; `similar`: parecida pelo nome, sem o EAN.
   */
  origin: 'same-ean' | 'same-name' | 'similar';
  /** Fonte do EAN (só em `same-ean`): dotcompany, manual, off… */
  source?: string | null;
  score?: number;
  isClientPreferred: boolean;
}

export interface AliasStatusEntry {
  productId: string;
  /** Quantas fotos já foram escolhidas antes para este nome. */
  images: number;
  /** `matched`: uma só, aplicada direto; `review`: várias, foram para a revisão. */
  status: 'matched' | 'review';
}

export interface FlyerMatchResult extends MatchV2Result {
  alternatives: Array<{ productId: string; options: PhotoOption[] }>;
  /** Produtos cuja consulta/importação continua em segundo plano. */
  pending: string[];
  eanStatus: EanStatusEntry[];
  /** Produtos resolvidos pelo nome já escolhido antes (fora os resolvidos por EAN). */
  aliasStatus: AliasStatusEntry[];
}

interface GalleryAliasRow {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  filename: string;
  key: string;
  chosenAt: string | null;
  preferred: boolean;
}

interface GalleryEanRow {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  filename: string;
  ean: string;
  source: string | null;
  preferred: boolean;
}

/** Variantes de grafia do mesmo GTIN gravadas na galeria (zero à esquerda). */
function variants(ean: string): string[] {
  const set = new Set([ean, ean.replace(/^0+/, ''), ean.padStart(13, '0'), ean.padStart(14, '0')]);
  return [...set].filter(Boolean);
}

/** Preferida do cliente > foto de outra fonte > foto DotCompany. */
function rank(row: GalleryEanRow): number {
  if (row.preferred) return 0;
  if (row.source !== 'dotcompany') return 1;
  return 2;
}

/**
 * Busca de imagens dos produtos do encarte com EAN (spec
 * `flyer-product-ean-resolution`): galeria pelo EAN → DotCompany (consulta do
 * encarte, com prioridade sobre os jobs) → importa a foto → e também oferece as
 * fotos parecidas da nossa base. Produtos sem EAN, inválidos, não encontrados
 * ou bloqueados por orçamento seguem o casamento por nome de sempre.
 */
@Injectable()
export class FlyerEanResolutionService {
  private readonly logger = new Logger(FlyerEanResolutionService.name);
  private readonly enabled: boolean;
  private readonly timeoutMs: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly matcher: ProductImageMatchV2Service,
    private readonly lookups: DotcompanyLookupService,
    private readonly photos: DotcompanyPhotoImporter,
    private readonly jobs: EanImportJobService,
    private readonly runner: EanImportRunner,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<string>('EAN_FLYER_RESOLVE_ENABLED', 'true') !== 'false';
    const t = Number.parseInt(configService.get<string>('EAN_FLYER_RESOLVE_TIMEOUT_MS') ?? '', 10);
    this.timeoutMs = Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;
  }

  async findImages(
    products: ProductMatchInputV2[],
    clientId?: string | null,
  ): Promise<FlyerMatchResult> {
    const eanStatus: EanStatusEntry[] = [];
    const withEan: Array<{ product: ProductMatchInputV2; ean: string }> = [];

    for (const product of products) {
      const raw = product.ean?.trim();
      if (!raw) continue;
      const c = classifyEan(raw);
      if (c.status === 'valid') withEan.push({ product, ean: c.ean });
      else
        eanStatus.push({
          productId: product.id,
          ean: c.ean || raw,
          status: 'invalid',
          reason: c.reason,
        });
    }

    // Fotos já escolhidas antes para o MESMO NOME: entram fixas no pool de
    // candidatas do casamento por nome, para receberem o score híbrido real.
    const byAlias = await this.galleryByAlias(products, clientId ?? null);
    const pinnedImageIds = new Map<string, string[]>();
    for (const [productId, rows] of byAlias) {
      pinnedImageIds.set(
        productId,
        rows.map((r) => r.id),
      );
    }

    // Casamento por nome de TODOS os produtos, em paralelo com a resolução por EAN.
    const [byName, byEan] = await Promise.all([
      this.matcher.matchWithCandidates(products, clientId, { pinnedImageIds }),
      this.resolveEans(withEan, clientId ?? null),
    ]);

    // Quem tem EAN resolvido ou nome já escolhido antes não segue pela IA.
    const aliasResolved = new Set(
      [...byAlias.keys()].filter((productId) => !byEan.images.has(productId)),
    );
    const decided = (productId: string) =>
      byEan.images.has(productId) || aliasResolved.has(productId);
    const matches = byName.result.matches.filter((m) => !decided(m.productId));
    const reviewCandidates = byName.result.reviewCandidates.filter((r) => !decided(r.productId));
    const alternatives: FlyerMatchResult['alternatives'] = [];
    const aliasStatus: AliasStatusEntry[] = [];

    for (const productId of aliasResolved) {
      const rows = byAlias.get(productId) ?? [];
      const pool = byName.candidates.get(productId) ?? [];
      const poolById = new Map(pool.map((c) => [c.imageId, c]));
      const chosenAt = new Map(rows.map((r) => [r.id, r.chosenAt ?? '']));

      const candidates: ScoredCandidateV2[] = rows
        .map((r) => {
          const scored = poolById.get(r.id);
          return scored
            ? { ...scored, reasons: [ALIAS_REASON, ...scored.reasons] }
            : {
                imageId: r.id,
                url: r.url,
                thumbnailUrl: r.thumbnailUrl,
                filename: r.filename,
                folderName: null,
                score: 0,
                reasons: [ALIAS_REASON],
                isClientPreferred: r.preferred,
              };
        })
        .sort(
          (a, b) =>
            Number(b.isClientPreferred) - Number(a.isClientPreferred) ||
            b.score - a.score ||
            (chosenAt.get(b.imageId) ?? '').localeCompare(chosenAt.get(a.imageId) ?? ''),
        );

      const aliasIds = new Set(rows.map((r) => r.id));
      const similar = pool
        .filter((c) => !aliasIds.has(c.imageId) && c.score >= SIMILAR_MIN_SCORE)
        .slice(0, SIMILAR_TOP_N);

      if (candidates.length === 1) {
        // Uma foto só para este nome: vai direto para o card, como o EAN.
        const [best] = candidates;
        matches.push({
          productId,
          imageId: best.imageId,
          imageUrl: best.url,
          score: best.score,
          reasons: best.reasons,
          isClientPreferred: best.isClientPreferred,
        });
        const options: PhotoOption[] = similar.map((c) => ({
          imageId: c.imageId,
          url: c.url,
          thumbnailUrl: c.thumbnailUrl,
          filename: c.filename,
          origin: 'similar' as const,
          score: c.score,
          isClientPreferred: c.isClientPreferred,
        }));
        if (options.length) alternatives.push({ productId, options });
        aliasStatus.push({ productId, images: 1, status: 'matched' });
      } else {
        // Várias fotos já escolhidas para este nome (embalagens de épocas
        // diferentes): o usuário escolhe entre as melhores pelo score.
        reviewCandidates.push({ productId, candidates: candidates.slice(0, ALIAS_REVIEW_TOP_N) });
        aliasStatus.push({ productId, images: candidates.length, status: 'review' });
      }
    }

    for (const { product, ean } of withEan) {
      eanStatus.push(
        byEan.status.get(product.id) ?? { productId: product.id, ean, status: 'not_found' },
      );
      const rows = byEan.images.get(product.id);
      if (!rows?.length) continue;

      const [best, ...others] = [...rows].sort((a, b) => rank(a) - rank(b));
      matches.push({
        productId: product.id,
        imageId: best.id,
        imageUrl: best.url,
        score: 1,
        reasons: ['EAN igual', `fonte: ${best.source ?? 'sem fonte'}`],
        isClientPreferred: best.preferred,
      });

      const sameEanIds = new Set(rows.map((r) => r.id));
      const similar = (byName.candidates.get(product.id) ?? [])
        .filter(
          (c: ScoredCandidateV2) => !sameEanIds.has(c.imageId) && c.score >= SIMILAR_MIN_SCORE,
        )
        .slice(0, SIMILAR_TOP_N);

      const options: PhotoOption[] = [
        ...others.map((r) => ({
          imageId: r.id,
          url: r.url,
          thumbnailUrl: r.thumbnailUrl,
          filename: r.filename,
          origin: 'same-ean' as const,
          source: r.source,
          isClientPreferred: r.preferred,
        })),
        ...similar.map((c) => ({
          imageId: c.imageId,
          url: c.url,
          thumbnailUrl: c.thumbnailUrl,
          filename: c.filename,
          origin: 'similar' as const,
          score: c.score,
          isClientPreferred: c.isClientPreferred,
        })),
      ];
      if (options.length) alternatives.push({ productId: product.id, options });
    }

    return {
      matches,
      reviewCandidates,
      scanned: products.length,
      matched: matches.length,
      alternatives,
      pending: byEan.pending,
      eanStatus,
      aliasStatus,
    };
  }

  /**
   * Imagens já escolhidas antes para o nome de cada produto (`metadata.aliases`),
   * com a marca de preferida do cliente. Produtos sem nome útil ficam de fora.
   */
  private async galleryByAlias(
    products: ProductMatchInputV2[],
    clientId: string | null,
  ): Promise<Map<string, GalleryAliasRow[]>> {
    const out = new Map<string, GalleryAliasRow[]>();
    const productsByKey = new Map<string, string[]>();
    for (const p of products) {
      const key = productAliasKey(p.name);
      if (!key) continue;
      productsByKey.set(key, [...(productsByKey.get(key) ?? []), p.id]);
    }
    if (productsByKey.size === 0) return out;

    const keys = [...productsByKey.keys()];
    const rows: GalleryAliasRow[] = await this.dataSource.query(
      `SELECT gi.id, gi.url, gi."thumbnailUrl", gi.filename,
              a->>'key' AS key, a->>'chosenAt' AS "chosenAt",
              ($2::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM client_preferred_images cpi
                  WHERE cpi.image_id = gi.id AND cpi.client_id = $2::uuid)) AS preferred
         FROM gallery_images gi,
              jsonb_array_elements(gi.metadata->'aliases') a
        WHERE gi.metadata->'aliases' @> ANY (
                SELECT jsonb_build_array(jsonb_build_object('key', k)) FROM unnest($1::text[]) k)
          AND a->>'key' = ANY($1::text[])`,
      [keys, clientId],
    );
    for (const r of rows) {
      for (const productId of productsByKey.get(r.key) ?? []) {
        const list = out.get(productId) ?? [];
        if (!list.some((x) => x.id === r.id)) list.push({ ...r, preferred: Boolean(r.preferred) });
        out.set(productId, list);
      }
    }
    return out;
  }

  /**
   * Para cada produto com EAN válido: imagens da galeria com esse EAN; o que
   * falta vai à DotCompany (interativo) dentro do prazo, e o que não terminar
   * vira job em segundo plano.
   */
  private async resolveEans(
    items: Array<{ product: ProductMatchInputV2; ean: string }>,
    clientId: string | null,
  ): Promise<{
    images: Map<string, GalleryEanRow[]>;
    status: Map<string, EanStatusEntry>;
    pending: string[];
  }> {
    const images = new Map<string, GalleryEanRow[]>();
    const status = new Map<string, EanStatusEntry>();
    const pending: string[] = [];
    if (items.length === 0) return { images, status, pending };

    const inGallery = await this.galleryByEan(
      items.map((i) => i.ean),
      clientId,
    );
    const missing: typeof items = [];
    for (const item of items) {
      const rows = inGallery.get(item.ean);
      if (rows?.length) {
        images.set(item.product.id, rows);
        status.set(item.product.id, {
          productId: item.product.id,
          ean: item.ean,
          status: 'gallery',
        });
      } else missing.push(item);
    }
    if (missing.length === 0 || !this.enabled) {
      for (const m of missing) {
        status.set(m.product.id, {
          productId: m.product.id,
          ean: m.ean,
          status: this.enabled ? 'not_found' : 'budget_blocked',
          reason: this.enabled ? null : 'busca por EAN desligada',
        });
      }
      return { images, status, pending };
    }

    // O prazo só faz o encarte parar de ESPERAR: a consulta paga e a importação da
    // foto seguem até o fim em segundo plano (cache e consumo gravados; nada de
    // cobrança em dobro). Quem estourou o prazo vira job `flyer`, que lê o cache.
    const work = this.lookupAndImport(missing, clientId);
    const result = await this.withDeadline(work);
    let toBackground: typeof items;
    if (result) {
      for (const [id, entry] of result.status) status.set(id, entry);
      for (const [id, rows] of result.images) images.set(id, rows);
      toBackground = result.toBackground;
    } else {
      this.logger.warn(
        `Prazo da busca por EAN (${this.timeoutMs} ms) esgotado: ${missing.length} produto(s) seguem em segundo plano.`,
      );
      toBackground = missing;
    }

    if (toBackground.length) {
      const unique = [...new Map(toBackground.map((t) => [t.product.id, t])).values()];
      try {
        await this.jobs.criarJobDoEncarte(
          unique.map((t) => ({ ean: t.ean, description: t.product.name })),
          clientId,
        );
        this.runner.wake();
        for (const t of unique) {
          pending.push(t.product.id);
          status.set(t.product.id, { productId: t.product.id, ean: t.ean, status: 'pending' });
        }
      } catch (err) {
        this.logger.warn(
          `Não consegui agendar os EANs pendentes do encarte: ${(err as Error).message}`,
        );
        for (const t of unique) {
          status.set(t.product.id, {
            productId: t.product.id,
            ean: t.ean,
            status: 'not_found',
            reason: 'falha ao agendar',
          });
        }
      }
    }

    return { images, status, pending };
  }

  /** Resolve com `null` se `work` não terminar no prazo (sem cancelar `work`). */
  private async withDeadline<T>(work: Promise<T>): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      // Se perdeu a corrida, o resultado tardio só precisa não virar rejeição solta.
      work.catch(() => undefined);
    }
  }

  /** Consulta a DotCompany e importa as fotos dos faltantes; nunca lança. */
  private async lookupAndImport(
    missing: Array<{ product: ProductMatchInputV2; ean: string }>,
    clientId: string | null,
  ): Promise<{
    images: Map<string, GalleryEanRow[]>;
    status: Map<string, EanStatusEntry>;
    toBackground: typeof missing;
  }> {
    const images = new Map<string, GalleryEanRow[]>();
    const status = new Map<string, EanStatusEntry>();
    const toBackground: typeof missing = [];
    try {
      const summary = await this.lookups.resolve(
        missing.map((m) => m.ean),
        { kind: 'interactive' },
      );
      const found: Array<{
        item: (typeof missing)[number];
        lookup: NonNullable<ReturnType<typeof summary.outcomes.get>>['lookup'];
      }> = [];
      for (const item of missing) {
        const o = summary.outcomes.get(item.ean);
        const base = { productId: item.product.id, ean: item.ean };
        if (o?.status === 'found' && o.lookup) found.push({ item, lookup: o.lookup });
        else if (o?.status === 'blocked' && o.blockReason === 'batch_in_flight') {
          // Lote já enviado e ainda processando na DotCompany: o job `flyer` retoma com a MESMA chave
          // (respeita o `retryNotBefore`) e o encarte devolve o EAN como pendente.
          toBackground.push(item);
        } else if (o?.status === 'blocked') {
          status.set(item.product.id, {
            ...base,
            status: 'budget_blocked',
            reason: o.reason ?? o.blockReason ?? null,
          });
        } else if (o?.status === 'error' && !summary.authError) toBackground.push(item);
        else {
          status.set(item.product.id, {
            ...base,
            status: o?.status === 'error' ? 'budget_blocked' : 'not_found',
            reason: o?.reason ?? null,
          });
        }
      }

      if (found.length) {
        const imported = await this.photos.importMany(
          found.map((f) => ({ ean: f.item.ean, lookup: f.lookup! })),
          { kind: 'interactive', concurrency: 6 },
        );
        const ok: typeof missing = [];
        for (const f of found) {
          const r = imported.get(f.item.ean);
          if (r?.status === 'imported' || r?.status === 'already_exists') ok.push(f.item);
          else if (r?.status === 'no_image') {
            status.set(f.item.product.id, {
              productId: f.item.product.id,
              ean: f.item.ean,
              status: 'not_found',
              reason: 'DotCompany sem foto',
            });
          } else toBackground.push(f.item);
        }
        if (ok.length) {
          const fresh = await this.galleryByEan(
            ok.map((o) => o.ean),
            clientId,
          );
          for (const item of ok) {
            const rows = fresh.get(item.ean) ?? [];
            if (rows.length) images.set(item.product.id, rows);
            status.set(item.product.id, {
              productId: item.product.id,
              ean: item.ean,
              status: 'dotcompany',
            });
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Resolução por EAN do encarte falhou: ${(err as Error).message}`);
      for (const m of missing) if (!status.has(m.product.id)) toBackground.push(m);
    }
    return { images, status, toBackground };
  }

  /** Imagens da galeria por EAN (todas as fontes), com a marca de preferida do cliente. */
  private async galleryByEan(
    eans: string[],
    clientId: string | null,
  ): Promise<Map<string, GalleryEanRow[]>> {
    const byVariant = new Map<string, string>();
    for (const ean of eans) for (const v of variants(ean)) byVariant.set(v, ean);
    const rows: Array<Omit<GalleryEanRow, 'ean'> & { ean: string }> = await this.dataSource.query(
      `SELECT gi.id, gi.url, gi."thumbnailUrl", gi.filename,
              gi.metadata->>'ean' AS ean,
              gi.metadata->>'eanSource' AS source,
              ($2::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM client_preferred_images cpi
                  WHERE cpi.image_id = gi.id AND cpi.client_id = $2::uuid)) AS preferred
         FROM gallery_images gi
        WHERE gi.metadata->>'ean' = ANY($1)
        ORDER BY gi."createdAt" ASC`,
      [[...byVariant.keys()], clientId],
    );
    const out = new Map<string, GalleryEanRow[]>();
    for (const r of rows) {
      const ean = byVariant.get(r.ean);
      if (!ean) continue;
      const list = out.get(ean) ?? [];
      list.push({ ...r, ean, preferred: Boolean(r.preferred) });
      out.set(ean, list);
    }
    return out;
  }
}
