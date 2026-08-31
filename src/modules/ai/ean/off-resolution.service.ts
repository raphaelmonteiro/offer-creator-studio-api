import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GalleryEmbeddingService } from '../gallery-embedding.service';
import {
  canOverwriteEan,
  EanCandidate,
  ProductMetadata,
} from '../metadata/product-metadata.schema';
import {
  canonicalQuantity,
  isPlausibleRetailGtin,
  normalizeBrand,
  parseFreeTextQuantity,
  quantityMatches,
} from './gtin.util';
import {
  discriminatorSignature,
  overlapScore,
  sharedRareTokens,
  unmatchedRareTokens,
  variantGate,
} from './variant-token.util';

/**
 * Feature 14 — Fase 2: resolve EAN contra o espelho local da Open Food Facts.
 *
 * Gratuito, offline e sem cota — roda antes do Cosmos e reduz o volume pago.
 * A regra de aceite vem do spec: só grava sozinho quando marca E quantidade
 * batem e a resposta é inequívoca. Ambiguidade vai para revisão humana, nunca
 * para o banco.
 */

// Tolerância de quantidade no lookup (mesma do quantityMatches: 2%).
const QUANTITY_TOLERANCE = 0.02;
const CANDIDATE_POOL = 20;
const REVIEW_TOP_N = 3;

// Confiança gravada em `eanConfidence` por tipo de aceite.
const CONFIDENCE_SINGLE_HIT = 0.9;
const CONFIDENCE_MARGIN = 0.75;

/**
 * Camada 5 — regra da margem. Medição da pesquisa: limiar sobre score
 * ABSOLUTO não move a precisão (75,3% em qualquer corte), enquanto exigir
 * margem de 0,2 entre o 1º e o 2º colocado levou a precisão a 100%. Predição
 * seletiva depende de confiança RELATIVA, não de calibração absoluta.
 */
const MARGIN_MIN = 0.2;

interface OffCandidateRow {
  gtin: string;
  product_name: string | null;
  brand_raw: string | null;
  name_similarity: number;
}

export interface OffResolutionOutcome {
  status: 'resolved' | 'review' | 'unresolved';
  ean: string | null;
  confidence: number | null;
  candidates: EanCandidate[];
}

@Injectable()
export class OffResolutionService {
  private readonly logger = new Logger(OffResolutionService.name);

  /** Frequência documental dos tokens da OFF — carregada uma vez, em cache. */
  private documentFrequency: Map<string, number> | null = null;
  private totalDocuments = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly embedding: GalleryEmbeddingService,
  ) {}

  /**
   * Constrói o mapa token → nº de documentos a partir de `product_name`.
   * ~20k tokens distintos em 33k produtos: cabe em memória com folga e evita
   * uma query por candidato.
   */
  private async loadDocumentFrequency(): Promise<void> {
    if (this.documentFrequency) return;

    const rows: Array<{ token: string; n: string }> = await this.dataSource.query(
      `WITH tok AS (
         SELECT DISTINCT gtin,
                unnest(string_to_array(lower(unaccent(coalesce(product_name, ''))), ' ')) AS t
           FROM off_products
          WHERE product_name IS NOT NULL
       )
       SELECT t AS token, COUNT(*)::text AS n
         FROM tok
        WHERE length(t) >= 3
        GROUP BY t`,
    );

    const map = new Map<string, number>();
    for (const row of rows) map.set(row.token, Number(row.n));

    const [total] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM off_products WHERE product_name IS NOT NULL`,
    );

    this.documentFrequency = map;
    this.totalDocuments = total?.n ?? 0;
    this.logger.log(
      `Frequência documental carregada: ${map.size} tokens sobre ${this.totalDocuments} produtos.`,
    );
  }

  /** A tabela só existe depois da ingestão do dump. */
  async isReady(): Promise<boolean> {
    const [row] = await this.dataSource.query(
      `SELECT to_regclass('public.off_products') IS NOT NULL AS ok`,
    );
    if (!row?.ok) return false;
    const [count] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM off_products`);
    return (count?.n ?? 0) > 0;
  }

  /**
   * Fila: imagens consultáveis (marca + quantidade) que ainda não passaram
   * pela resolução da OFF. `eanStatus` ausente = nunca tentada.
   */
  async listPending(
    limit: number,
  ): Promise<Array<{ id: string; filename: string; metadata: ProductMetadata }>> {
    return this.dataSource.query(
      `SELECT id, filename, metadata
         FROM gallery_images
        WHERE metadata IS NOT NULL
          AND metadata->'alternatives'->0->>'brand' IS NOT NULL
          AND metadata->'quantity' IS NOT NULL
          AND metadata->'quantity' <> 'null'::jsonb
          AND metadata->>'eanStatus' IS NULL
        ORDER BY "createdAt"
        LIMIT $1`,
      [limit],
    );
  }

  async countPending(): Promise<number> {
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n
         FROM gallery_images
        WHERE metadata IS NOT NULL
          AND metadata->'alternatives'->0->>'brand' IS NOT NULL
          AND metadata->'quantity' IS NOT NULL
          AND metadata->'quantity' <> 'null'::jsonb
          AND metadata->>'eanStatus' IS NULL`,
    );
    return row?.n ?? 0;
  }

  /**
   * Busca candidatos por marca normalizada + quantidade canônica, ordenados
   * por similaridade de nome. O filtro de marca e quantidade acontece no SQL,
   * então toda linha devolvida já é um casamento de marca+quantidade.
   */
  private async findCandidates(metadata: ProductMetadata): Promise<OffCandidateRow[]> {
    const brand = normalizeBrand(metadata.alternatives?.[0]?.brand);
    const quantity = canonicalQuantity(metadata.quantity);
    if (!brand || !quantity) return [];

    const delta = quantity.value * QUANTITY_TOLERANCE;
    const nameProbe = [metadata.title, metadata.alternatives?.[0]?.variant]
      .filter((p): p is string => Boolean(p && p.trim()))
      .join(' ');

    return this.dataSource.query(
      `SELECT gtin,
              product_name,
              brand_raw,
              COALESCE(similarity(COALESCE(product_name, ''), $4), 0) AS name_similarity
         FROM off_products
        WHERE brand_norm = $1
          AND quantity_unit = $2
          AND quantity_value BETWEEN $3::numeric - $5::numeric AND $3::numeric + $5::numeric
        ORDER BY name_similarity DESC
        LIMIT ${CANDIDATE_POOL}`,
      [brand, quantity.unit, quantity.value, nameProbe, delta],
    );
  }

  /**
   * Decide entre gravar, mandar para revisão ou desistir.
   *
   * - 1 candidato .......... grava (marca + quantidade já bateram no SQL)
   * - N candidatos ......... só grava se o nome desempatar com folga
   * - 0 candidatos ......... não resolvido; segue para o Cosmos
   */
  /**
   * Texto do lado da galeria para o portão de variante. Inclui o FILENAME de
   * propósito: ele costuma carregar o discriminante que a visão não extraiu
   * ("Caldo Nobre - carioca 1kg" tem o tipo do feijão; o título só diz
   * "Feijão Caldo Nobre").
   */
  private expectedText(metadata: ProductMetadata, filename: string): string {
    return [
      metadata.title,
      metadata.alternatives?.[0]?.variant,
      filename.replace(/\.[a-z0-9]+$/i, ''),
    ]
      .filter((p): p is string => Boolean(p && p.trim()))
      .join(' ');
  }

  /**
   * Camadas 4 e 5. Estados possíveis:
   *
   * - `resolved`   (MATCH)    grava o EAN
   * - `review`     (POSSIBLE) guarda os candidatos, NÃO grava EAN — não é fila
   * - `unresolved` (NO_MATCH) segue para o Cosmos
   */
  async resolveOne(metadata: ProductMetadata, filename: string): Promise<OffResolutionOutcome> {
    const rows = await this.findCandidates(metadata);
    const plausible = rows.filter((r) => isPlausibleRetailGtin(r.gtin));
    if (plausible.length === 0) {
      return { status: 'unresolved', ean: null, confidence: null, candidates: [] };
    }

    const expected = this.expectedText(metadata, filename);

    // Camada 4d — a quantidade do metadata precisa bater com a do filename.
    // Discordância significa que a extração por visão errou (medido:
    // "Tio Joao - tipo 1 5kg.jpg" com quantity 1000g), e um blocking feito
    // sobre quantidade errada casa com o produto errado.
    const filenameQuantity = parseFreeTextQuantity(filename.replace(/\.[a-z0-9]+$/i, ''));
    if (
      filenameQuantity &&
      !quantityMatches(filenameQuantity, canonicalQuantity(metadata.quantity))
    ) {
      return { status: 'unresolved', ean: null, confidence: null, candidates: [] };
    }

    await this.loadDocumentFrequency();
    const brand = metadata.alternatives?.[0]?.brand ?? null;

    // Texto "limpo" (sem filename) para a camada 4c — ver unmatchedRareTokens.
    const expectedClean = [metadata.title, metadata.alternatives?.[0]?.variant]
      .filter((p): p is string => Boolean(p && p.trim()))
      .join(' ');

    // Camadas 4 e 4b — conflito/subespecificação de variante eliminam, e o que
    // sobra precisa compartilhar ao menos um token RARO (identidade de linha de
    // produto). Token comum não conta: o blocking por marca já implicava a
    // categoria, então "chocolate" em comum é evidência nula.
    const gated = plausible
      .map((r) => ({ row: r, gate: variantGate(expected, r.product_name ?? '') }))
      .filter((c) => c.gate.pass)
      .filter(
        (c) =>
          sharedRareTokens(
            expected,
            c.row.product_name ?? '',
            this.documentFrequency!,
            this.totalDocuments,
            brand,
          ).length > 0,
      )
      // Camada 4c — nenhum atributo discriminante pode ficar sem correspondência,
      // NOS DOIS SENTIDOS. A direção candidato→galeria é a que pega o padrão
      // residual medido: a galeria diz "Lacta ao leite" e o candidato é
      // "Diamante Negro"; a galeria diz "Alpino" e o candidato é "Black". Só
      // olhar galeria→candidato deixava esses passarem.
      .filter(
        (c) =>
          unmatchedRareTokens(
            expectedClean,
            c.row.product_name ?? '',
            this.documentFrequency!,
            this.totalDocuments,
            brand,
          ).length === 0 &&
          unmatchedRareTokens(
            c.row.product_name ?? '',
            expectedClean,
            this.documentFrequency!,
            this.totalDocuments,
            brand,
          ).length === 0,
      )
      .map((c) => ({ ...c, score: overlapScore(expected, c.row.product_name ?? '') }))
      .sort((a, b) => b.score - a.score);

    if (gated.length === 0) {
      return { status: 'unresolved', ean: null, confidence: null, candidates: [] };
    }

    const candidates: EanCandidate[] = gated.slice(0, REVIEW_TOP_N).map((c) => ({
      ean: c.row.gtin,
      source: 'off' as const,
      score: Number(c.score.toFixed(4)),
      description: c.row.product_name,
    }));

    // Camada 5 — margem. Com um único sobrevivente, quem sustenta a decisão é
    // o portão de variante; com vários, exige-se separação clara do segundo.
    const distinct = new Set(gated.map((c) => c.row.gtin));
    if (distinct.size === 1) {
      return {
        status: 'resolved',
        ean: gated[0].row.gtin,
        confidence: CONFIDENCE_SINGLE_HIT,
        candidates,
      };
    }

    const margin = gated[0].score - gated[1].score;
    if (margin >= MARGIN_MIN) {
      return {
        status: 'resolved',
        ean: gated[0].row.gtin,
        confidence: CONFIDENCE_MARGIN,
        candidates,
      };
    }

    return { status: 'review', ean: null, confidence: null, candidates };
  }

  private applyOutcome(
    current: ProductMetadata,
    outcome: OffResolutionOutcome,
    now: string,
  ): ProductMetadata {
    const next: ProductMetadata = {
      ...current,
      eanStatus: outcome.status,
      eanCandidates: outcome.candidates,
    };

    if (outcome.status === 'resolved' && outcome.ean) {
      // Precedência: a OFF é a fonte de menor confiança e não sobrescreve
      // nada que já tenha vindo de fonte melhor.
      if (canOverwriteEan(current.eanSource ?? null, 'off')) {
        next.ean = outcome.ean;
        next.eanSource = 'off';
        next.eanConfidence = outcome.confidence;
        next.eanVerifiedAt = now;
      }
    }

    return next;
  }

  /**
   * Camada 5b — unicidade global de GTIN.
   *
   * Um EAN identifica UM produto. Se duas imagens com discriminantes
   * DIFERENTES resolvem para o mesmo GTIN, no máximo uma está certa — e como
   * não há como saber qual, rejeitam-se todas (viram `review`, sem EAN
   * gravado). Várias fotos do MESMO produto (mesma assinatura de
   * discriminantes) continuam válidas.
   *
   * É o "veto duro em campo identificador" que a literatura aponta como o
   * maior lever isolado de precisão. Roda como passada final porque é uma
   * restrição global — nenhuma decisão por imagem consegue enxergá-la.
   */
  async enforceGtinUniqueness(): Promise<{ groupsChecked: number; imagesRejected: number }> {
    const rows: Array<{ id: string; filename: string; ean: string; metadata: ProductMetadata }> =
      await this.dataSource.query(
        `SELECT id, filename, metadata->>'ean' AS ean, metadata
           FROM gallery_images
          WHERE metadata->>'eanStatus' = 'resolved'
            AND metadata->>'ean' IS NOT NULL
            AND metadata->>'eanSource' = 'off'`,
      );

    const byEan = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byEan.get(row.ean) ?? [];
      list.push(row);
      byEan.set(row.ean, list);
    }

    let imagesRejected = 0;
    let groupsChecked = 0;

    for (const [ean, group] of byEan) {
      if (group.length < 2) continue;
      groupsChecked += 1;

      const signatures = new Set(
        group.map((row) => discriminatorSignature(this.expectedText(row.metadata, row.filename))),
      );
      if (signatures.size <= 1) continue; // mesmas fotos do mesmo produto

      for (const row of group) {
        const next: ProductMetadata = {
          ...row.metadata,
          ean: null,
          eanSource: null,
          eanConfidence: null,
          eanVerifiedAt: null,
          eanStatus: 'review',
          warnings: [
            ...(row.metadata.warnings ?? []),
            `ean-uniqueness: ${ean} disputado por ${group.length} imagens distintas`,
          ],
        };
        await this.embedding.saveImageMetadata(row.id, next);
        imagesRejected += 1;
      }

      this.logger.warn(
        `GTIN ${ean} disputado por ${group.length} imagens com discriminantes distintos — todas rejeitadas.`,
      );
    }

    return { groupsChecked, imagesRejected };
  }

  async resolve(options: { batchSize?: number; maxBatches?: number; dryRun?: boolean }): Promise<{
    scanned: number;
    resolved: number;
    review: number;
    unresolved: number;
    uniquenessRejected: number;
    dryRun: boolean;
  }> {
    const batchSize = Math.min(Math.max(options.batchSize ?? 200, 1), 1000);
    const maxBatches = Math.min(Math.max(options.maxBatches ?? 1, 1), 100);
    const dryRun = options.dryRun ?? false;

    let scanned = 0;
    let resolved = 0;
    let review = 0;
    let unresolved = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = await this.listPending(batchSize);
      if (rows.length === 0) break;
      scanned += rows.length;

      for (const row of rows) {
        const outcome = await this.resolveOne(row.metadata, row.filename);
        if (outcome.status === 'resolved') resolved += 1;
        else if (outcome.status === 'review') review += 1;
        else unresolved += 1;

        if (dryRun) continue;

        const next = this.applyOutcome(row.metadata, outcome, new Date().toISOString());
        await this.embedding.saveImageMetadata(row.id, next);
      }

      this.logger.log(
        `Fase 2 (OFF) — lote ${batch + 1}: scanned=${scanned} resolved=${resolved} review=${review} unresolved=${unresolved}${dryRun ? ' (dry-run)' : ''}`,
      );

      // Em dry-run nada é escrito, então a fila não drena e reler o mesmo
      // lote não acrescenta informação.
      if (dryRun) break;
    }

    // Camada 5b só faz sentido sobre dados persistidos e sobre o conjunto
    // inteiro — por isso fora do laço de lotes.
    let uniquenessRejected = 0;
    if (!dryRun) {
      const uniqueness = await this.enforceGtinUniqueness();
      uniquenessRejected = uniqueness.imagesRejected;
      resolved -= uniquenessRejected;
      review += uniquenessRejected;
    }

    return { scanned, resolved, review, unresolved, uniquenessRejected, dryRun };
  }
}
