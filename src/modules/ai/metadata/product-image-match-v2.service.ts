import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GalleryEmbeddingService, MetadataEmbeddingMatch } from '../gallery-embedding.service';
import { ProductNameParserService } from './product-name-parser.service';
import { Alternative, buildEmbeddingText, ProductMetadata } from './product-metadata.schema';
import { TaxonomyService } from './taxonomy/taxonomy.service';

const AUTO_MATCH_THRESHOLD = 0.75;
const REVIEW_MIN_THRESHOLD = 0.5;
const CANDIDATE_POOL = 15;
const REVIEW_TOP_N = 3;

// Default weights — used when EAN/SKU is available on at least one side.
const WEIGHTS = {
  id: 0.4,
  brand: 0.25,
  category: 0.15,
  text: 0.15,
  pack: 0.05,
} as const;

// Renormalized weights — used when no EAN/SKU exists anywhere (the common
// real-world case: spreadsheet rows never carry an EAN, and most catalog
// photos don't show one legibly). Without renormalization the score ceiling
// for a perfect non-EAN match capped at ~0.57 and the review threshold (0.5)
// was barely reachable. The 0.40 EAN slice is redistributed proportionally
// across the remaining four components.
const WEIGHTS_NO_ID = {
  id: 0,
  brand: 0.45,
  category: 0.25,
  text: 0.2,
  pack: 0.1,
} as const;

export interface ProductMatchInputV2 {
  id: string;
  name: string;
  category?: string | null;
  unit?: string | null;
}

export interface ScoredCandidateV2 {
  imageId: string;
  url: string;
  thumbnailUrl: string | null;
  filename: string;
  folderName: string | null;
  score: number;
  reasons: string[];
}

export interface ProductMatchHitV2 {
  productId: string;
  imageId: string;
  imageUrl: string;
  score: number;
  reasons: string[];
}

export interface ProductReviewCandidatesV2 {
  productId: string;
  candidates: ScoredCandidateV2[];
}

export interface MatchV2Result {
  matches: ProductMatchHitV2[];
  reviewCandidates: ProductReviewCandidatesV2[];
  scanned: number;
  matched: number;
}

@Injectable()
export class ProductImageMatchV2Service {
  private readonly logger = new Logger(ProductImageMatchV2Service.name);
  private readonly debugEnabled: boolean;

  constructor(
    private readonly embedding: GalleryEmbeddingService,
    private readonly nameParser: ProductNameParserService,
    private readonly taxonomy: TaxonomyService,
    private readonly configService: ConfigService,
  ) {
    this.debugEnabled =
      this.configService.get<string>('AI_MATCH_DEBUG', '0') === '1';
  }

  async findBestMatches(products: ProductMatchInputV2[]): Promise<MatchV2Result> {
    const scanned = products.length;
    if (scanned === 0) {
      return { matches: [], reviewCandidates: [], scanned: 0, matched: 0 };
    }

    const parsed = await this.nameParser.parseNames(
      products.map((p) => ({ name: p.name, categoryHint: p.category })),
    );

    const matches: ProductMatchHitV2[] = [];
    const reviewCandidates: ProductReviewCandidatesV2[] = [];

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const metadata = parsed[i];

      const candidates = await this.scoreCandidatesForProduct(product, metadata);

      if (this.debugEnabled) {
        this.logProductDebug(product, metadata, candidates);
      }

      if (candidates.length === 0) continue;

      const best = candidates[0];
      if (best.score >= AUTO_MATCH_THRESHOLD) {
        matches.push({
          productId: product.id,
          imageId: best.imageId,
          imageUrl: best.url,
          score: best.score,
          reasons: best.reasons,
        });
      } else if (best.score >= REVIEW_MIN_THRESHOLD) {
        reviewCandidates.push({
          productId: product.id,
          candidates: candidates.slice(0, REVIEW_TOP_N),
        });
      }
    }

    return {
      matches,
      reviewCandidates,
      scanned,
      matched: matches.length,
    };
  }

  async findCandidates(product: ProductMatchInputV2, limit: number): Promise<ScoredCandidateV2[]> {
    const parsed = await this.nameParser.parseSingle({
      name: product.name,
      categoryHint: product.category,
    });
    const sized = Math.min(Math.max(limit, 1), 24);
    const all = await this.scoreCandidatesForProduct(product, parsed);
    return all.slice(0, sized);
  }

  private async scoreCandidatesForProduct(
    product: ProductMatchInputV2,
    metadata: ProductMetadata | null,
  ): Promise<ScoredCandidateV2[]> {
    const queryText = metadata
      ? buildEmbeddingText(metadata)
      : [product.name, product.category, product.unit]
          .filter((v): v is string => !!v && v.trim().length > 0)
          .join(' ');

    if (!queryText) return [];

    const queryEmbedding = await this.embedding.embedText(queryText);
    if (!queryEmbedding) return [];

    const pool = await this.embedding.searchByMetadataEmbedding(queryEmbedding, CANDIDATE_POOL);

    const scored = pool.map((row) => this.scoreCandidate(metadata, row));

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  private scoreCandidate(
    productMeta: ProductMetadata | null,
    row: MetadataEmbeddingMatch,
  ): ScoredCandidateV2 {
    const imageMeta = row.metadata;
    const textCosine = clamp01(1 - row.distance);
    const reasons: string[] = [];

    const idScore = this.idScore(productMeta, imageMeta);
    if (idScore > 0) reasons.push('EAN igual');

    const brandScore = this.brandScore(productMeta, imageMeta);
    if (brandScore >= 1) reasons.push('marca + variante iguais');
    else if (brandScore >= 0.6) reasons.push('mesma marca');
    else if (brandScore > 0) reasons.push('marca não conferida');

    const categoryScore = this.categoryScore(productMeta, imageMeta);
    if (categoryScore >= 1) reasons.push('categoria igual');
    else if (categoryScore >= 0.5) reasons.push('categoria próxima');

    const packScore = this.packScore(productMeta, imageMeta);
    if (packScore >= 1) reasons.push('quantidade igual');

    if (textCosine >= 0.9) reasons.push('texto muito similar');

    const productConf = avg(productMeta?.fieldConfidence);
    const imageConf = avg(imageMeta?.fieldConfidence);
    const confidence = clamp01((productConf + imageConf) / 2);

    const hasEanAnywhere = Boolean(productMeta?.ean || imageMeta?.ean);
    const weights = hasEanAnywhere ? WEIGHTS : WEIGHTS_NO_ID;

    const score =
      weights.id * idScore +
      weights.brand * brandScore +
      weights.category * categoryScore +
      weights.text * textCosine +
      weights.pack * packScore;

    const final = clamp01(score * (0.8 + 0.2 * confidence));

    return {
      imageId: row.id,
      url: row.url,
      thumbnailUrl: row.thumbnailUrl,
      filename: row.filename,
      folderName: row.folderName,
      score: Number(final.toFixed(4)),
      reasons,
    };
  }

  private idScore(product: ProductMetadata | null, image: ProductMetadata | null): number {
    if (!product || !image) return 0;
    if (product.ean && image.ean && product.ean === image.ean) return 1;
    return 0;
  }

  private brandScore(product: ProductMetadata | null, image: ProductMetadata | null): number {
    if (!product || !image) return 0;
    const productAlts = product.alternatives ?? [];
    const imageAlts = image.alternatives ?? [];
    if (productAlts.length === 0 || imageAlts.length === 0) return 0;

    let best = 0;
    for (const pa of productAlts) {
      for (const ia of imageAlts) {
        best = Math.max(best, this.compareAlternative(pa, ia));
        if (best >= 1) return 1;
      }
    }
    return best;
  }

  private compareAlternative(a: Alternative, b: Alternative): number {
    const aBrand = norm(a.brand);
    const bBrand = norm(b.brand);

    if (!aBrand && !bBrand) {
      return 0.3;
    }
    if (!aBrand || !bBrand) return 0;
    if (aBrand !== bBrand) return 0;

    const aVariant = norm(a.variant);
    const bVariant = norm(b.variant);
    if (aVariant && bVariant && aVariant === bVariant) return 1;
    if (aVariant && bVariant && aVariant !== bVariant) return 0.7;
    return 0.6;
  }

  private categoryScore(product: ProductMetadata | null, image: ProductMetadata | null): number {
    if (!product?.category || !image?.category) return 0;
    return this.taxonomy.pathSimilarity(product.category.id, image.category.id);
  }

  private packScore(product: ProductMetadata | null, image: ProductMetadata | null): number {
    const pq = toCanonical(product?.quantity);
    const iq = toCanonical(image?.quantity);
    if (!pq || !iq) return 0;
    if (pq.family !== iq.family) return 0;
    const ratio = Math.min(pq.value, iq.value) / Math.max(pq.value, iq.value);
    if (ratio >= 0.98) return 1;
    if (ratio >= 0.9) return 0.6;
    return 0;
  }

  /**
   * Emits a structured debug log per product when AI_MATCH_DEBUG=1.
   * Shows what the LLM parser understood from the spreadsheet name and how
   * the top candidates scored — invaluable for telling apart "parser got it
   * wrong" from "score weights misbehaved".
   */
  private logProductDebug(
    product: ProductMatchInputV2,
    metadata: ProductMetadata | null,
    candidates: ScoredCandidateV2[],
  ): void {
    const top = candidates.slice(0, 3);

    if (!metadata) {
      this.logger.log(
        `[debug] "${product.name}" → parser FALHOU (sem metadata). ` +
          `${candidates.length} candidato(s) sem rerank útil.`,
      );
      return;
    }

    const primaryAlt = metadata.alternatives[0] ?? {};
    const altCount = metadata.alternatives.length;
    const altSuffix = altCount > 1 ? ` (+${altCount - 1} alt.)` : '';
    const cat = metadata.category ? metadata.category.path.join(' > ') : '∅';
    const qty = metadata.quantity
      ? `${metadata.quantity.value}${metadata.quantity.unit}`
      : '∅';
    const pack = metadata.pack
      ? `${metadata.pack.count}${metadata.pack.promoCount ? ` (promo ${metadata.pack.promoCount})` : ''}`
      : '∅';
    const conf = avg(metadata.fieldConfidence).toFixed(2);

    const parsedLine =
      `[debug] "${product.name}"\n` +
      `        parsed → title="${metadata.title}" brand="${primaryAlt.brand ?? '∅'}"${altSuffix} ` +
      `variant="${primaryAlt.variant ?? '∅'}" cat="${cat}" qty=${qty} pack=${pack} conf=${conf}`;

    const candLines = top.length
      ? top
          .map((c, i) => {
            const folder = c.folderName ? `${c.folderName}/` : '';
            const reasons = c.reasons.length ? c.reasons.join(', ') : '—';
            return `        #${i + 1} [${c.score.toFixed(3)}] ${folder}${c.filename} :: ${reasons}`;
          })
          .join('\n')
      : '        (sem candidatos)';

    this.logger.log(`${parsedLine}\n${candLines}`);
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function avg(fc: Record<string, number> | undefined | null): number {
  if (!fc) return 0;
  const values = Object.values(fc);
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function norm(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

type Family = 'mass' | 'volume' | 'count' | 'length';

interface CanonicalQuantity {
  value: number;
  family: Family;
}

const UNIT_TO_CANONICAL: Record<string, { factor: number; family: Family }> = {
  // mass → grams
  g: { factor: 1, family: 'mass' },
  kg: { factor: 1000, family: 'mass' },
  // volume → milliliters
  ml: { factor: 1, family: 'volume' },
  l: { factor: 1000, family: 'volume' },
  // discrete units
  un: { factor: 1, family: 'count' },
  // length → meters
  m: { factor: 1, family: 'length' },
};

/**
 * Normalizes a quantity to a canonical scale per family so values like
 * `5 kg` and `5000 g` (or `1 L` and `1000 ml`) are treated as equivalent.
 */
function toCanonical(
  q: { value?: number; unit?: string } | null | undefined,
): CanonicalQuantity | null {
  if (!q) return null;
  const { value, unit } = q;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (typeof unit !== 'string') return null;
  const def = UNIT_TO_CANONICAL[unit.toLowerCase()];
  if (!def) return null;
  return { value: value * def.factor, family: def.family };
}
