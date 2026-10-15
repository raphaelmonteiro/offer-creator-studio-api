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

/** Mesmo patamar de revisão do match-v2: abaixo disso a "parecida" não vale mostrar. */
const SIMILAR_MIN_SCORE = 0.5;
const SIMILAR_TOP_N = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

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
  /** `same-ean`: outra foto com o mesmo EAN; `similar`: parecida pelo nome, sem o EAN. */
  origin: 'same-ean' | 'similar';
  /** Fonte do EAN (só em `same-ean`): dotcompany, manual, off… */
  source?: string | null;
  score?: number;
  isClientPreferred: boolean;
}

export interface FlyerMatchResult extends MatchV2Result {
  alternatives: Array<{ productId: string; options: PhotoOption[] }>;
  /** Produtos cuja consulta/importação continua em segundo plano. */
  pending: string[];
  eanStatus: EanStatusEntry[];
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

    // Casamento por nome de TODOS os produtos, em paralelo com a resolução por EAN.
    const [byName, byEan] = await Promise.all([
      this.matcher.matchWithCandidates(products, clientId),
      this.resolveEans(withEan, clientId ?? null),
    ]);

    const matches = byName.result.matches.filter((m) => !byEan.images.has(m.productId));
    const reviewCandidates = byName.result.reviewCandidates.filter(
      (r) => !byEan.images.has(r.productId),
    );
    const alternatives: FlyerMatchResult['alternatives'] = [];

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
    };
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
        else if (o?.status === 'blocked') {
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
