import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GalleryEmbeddingService } from '../gallery-embedding.service';
import { ProductNameParserService } from './product-name-parser.service';
import { ProductMetadata } from './product-metadata.schema';

/**
 * Feature 14 — Fase 0.
 *
 * 28,7% da galeria (3.794 de 13.226 em produção) não tem marca ou quantidade
 * no metadata, e por isso não é consultável por descrição em nenhuma das
 * fontes de EAN (Open Food Facts, Cosmos). A extração por visão falha nesses
 * casos porque a informação simplesmente não está legível na foto.
 *
 * Mas os filenames da galeria seguem a convenção `Marca - variante qtd.ext`
 * ("Oliron - 5kg.jpg", "Tio Joao - arborio 500g.jpg"), que carrega exatamente
 * os campos que faltam. Esta service reaproveita o ProductNameParserService
 * (mesmo schema, já usado para nomes de planilha) para recuperá-los.
 *
 * Regra central: **preenche lacunas, nunca sobrescreve**. O que a visão
 * extraiu da imagem é sempre mais confiável que o que o operador digitou no
 * nome do arquivo — a categoria em especial (100% preenchida pela visão)
 * jamais é tocada.
 */

@Injectable()
export class FilenameMetadataRecoveryService {
  private readonly logger = new Logger(FilenameMetadataRecoveryService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nameParser: ProductNameParserService,
    private readonly embedding: GalleryEmbeddingService,
  ) {}

  isEnabled(): boolean {
    return this.nameParser.isEnabled();
  }

  /**
   * Imagens com metadata extraído mas sem marca ou sem quantidade — o
   * subconjunto que nenhuma fonte de EAN consegue consultar hoje.
   */
  async listImagesNeedingRecovery(
    limit: number,
    offset = 0,
  ): Promise<Array<{ id: string; filename: string; metadata: ProductMetadata }>> {
    return this.dataSource.query(
      `SELECT id, filename, metadata
         FROM gallery_images
        WHERE metadata IS NOT NULL
          AND (
            metadata->'alternatives'->0->>'brand' IS NULL
            OR metadata->'quantity' IS NULL
            OR metadata->'quantity' = 'null'::jsonb
          )
          -- Linhas já tentadas saem da fila mesmo quando nada foi recuperado.
          -- Sem isso elas voltam a cada lote e o job nunca avança (em produção,
          -- com mais irrecuperáveis que o batchSize, ele trava de vez).
          AND NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(COALESCE(metadata->'warnings', '[]'::jsonb)) AS w
             WHERE w LIKE 'filename-recovery%'
          )
        ORDER BY "createdAt"
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  async countImagesNeedingRecovery(): Promise<number> {
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n
         FROM gallery_images
        WHERE metadata IS NOT NULL
          AND (
            metadata->'alternatives'->0->>'brand' IS NULL
            OR metadata->'quantity' IS NULL
            OR metadata->'quantity' = 'null'::jsonb
          )
          -- Linhas já tentadas saem da fila mesmo quando nada foi recuperado.
          -- Sem isso elas voltam a cada lote e o job nunca avança (em produção,
          -- com mais irrecuperáveis que o batchSize, ele trava de vez).
          AND NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(COALESCE(metadata->'warnings', '[]'::jsonb)) AS w
             WHERE w LIKE 'filename-recovery%'
          )`,
    );
    return row?.n ?? 0;
  }

  /**
   * Converte o nome do arquivo no "nome de produto" que o parser espera.
   * Remove a extensão e os sufixos de variante de foto (" 002", " c3"), que
   * são marcadores de arquivo e não fazem parte da descrição do produto.
   */
  filenameToProductName(filename: string): string {
    return filename
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+0\d{2}$/i, '')
      .replace(/\s+c\d+$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Mescla o resultado do parser no metadata existente preenchendo apenas
   * lacunas. Retorna `null` quando nada foi recuperado (evita UPDATE inútil
   * e re-embedding desnecessário).
   */
  mergeIntoMetadata(
    current: ProductMetadata,
    parsed: ProductMetadata,
  ): { metadata: ProductMetadata; recovered: string[] } | null {
    const recovered: string[] = [];
    const next: ProductMetadata = { ...current };

    const currentAlt = current.alternatives?.[0];
    const parsedAlt = parsed.alternatives?.[0];

    if (parsedAlt) {
      const mergedAlt = { ...(currentAlt ?? { brand: null, subBrand: null, variant: null }) };
      if (!mergedAlt.brand && parsedAlt.brand) {
        mergedAlt.brand = parsedAlt.brand;
        recovered.push('brand');
      }
      if (!mergedAlt.subBrand && parsedAlt.subBrand) {
        mergedAlt.subBrand = parsedAlt.subBrand;
      }
      if (!mergedAlt.variant && parsedAlt.variant) {
        mergedAlt.variant = parsedAlt.variant;
        recovered.push('variant');
      }
      next.alternatives = [mergedAlt, ...(current.alternatives ?? []).slice(1)];
    }

    if (!current.quantity && parsed.quantity) {
      next.quantity = parsed.quantity;
      recovered.push('quantity');
    }

    if (!current.packageType && parsed.packageType) {
      next.packageType = parsed.packageType;
      recovered.push('packageType');
    }

    // `category` da visão nunca é sobrescrita — ela olha a foto, o filename não.
    // Só preenche se estiver genuinamente vazia.
    if (!current.category && parsed.category) {
      next.category = parsed.category;
      recovered.push('category');
    }

    if (recovered.length === 0) return null;

    next.warnings = [...(current.warnings ?? []), `filename-recovery: ${recovered.join(',')}`];

    return { metadata: next, recovered };
  }

  /**
   * Marca a imagem como já tentada, mesmo sem recuperação. É o que faz a fila
   * drenar e o job ser retomável entre execuções.
   */
  private async markAttempted(imageId: string, current: ProductMetadata): Promise<void> {
    const metadata: ProductMetadata = {
      ...current,
      warnings: [...(current.warnings ?? []), 'filename-recovery: none'],
    };
    await this.embedding.saveImageMetadata(imageId, metadata);
  }

  /**
   * Processa a fila em lotes. Com `dryRun`, calcula a taxa de recuperação sem
   * escrever nada — é assim que se mede o ganho antes de tocar na base.
   */
  async recover(options: { batchSize?: number; maxBatches?: number; dryRun?: boolean }): Promise<{
    scanned: number;
    recovered: number;
    skipped: number;
    failed: number;
    byField: Record<string, number>;
    dryRun: boolean;
  }> {
    const batchSize = Math.min(Math.max(options.batchSize ?? 50, 1), 200);
    const maxBatches = Math.min(Math.max(options.maxBatches ?? 1, 1), 100);
    const dryRun = options.dryRun ?? false;

    let scanned = 0;
    let recovered = 0;
    let skipped = 0;
    let failed = 0;
    const byField: Record<string, number> = {};

    // Em dry-run nada é escrito, então a janela não avança sozinha: pagina
    // por offset. Na execução real as linhas saem da fila ao serem corrigidas.
    let offset = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = await this.listImagesNeedingRecovery(batchSize, dryRun ? offset : 0);
      if (rows.length === 0) break;
      offset += rows.length;
      scanned += rows.length;

      const parsedBatch = await this.nameParser.parseNames(
        rows.map((row) => ({ name: this.filenameToProductName(row.filename) })),
      );

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const parsed = parsedBatch[i];

        if (!parsed) {
          failed += 1;
          if (!dryRun) await this.markAttempted(row.id, row.metadata);
          continue;
        }

        const merged = this.mergeIntoMetadata(row.metadata, parsed);
        if (!merged) {
          skipped += 1;
          if (!dryRun) await this.markAttempted(row.id, row.metadata);
          continue;
        }

        for (const field of merged.recovered) {
          byField[field] = (byField[field] ?? 0) + 1;
        }
        recovered += 1;

        if (dryRun) continue;

        try {
          await this.embedding.saveImageMetadata(row.id, merged.metadata);
          // buildEmbeddingText usa marca/variante/quantidade — o vetor precisa
          // ser refeito, senão o matcher continua vendo o metadata antigo.
          await this.embedding.embedAndStoreMetadataForImage(row.id, merged.metadata);
        } catch (error) {
          failed += 1;
          recovered -= 1;
          this.logger.warn(
            `Falha ao persistir recuperação de ${row.id}: ${(error as Error).message}`,
          );
        }
      }

      this.logger.log(
        `Fase 0 — lote ${batch + 1}: scanned=${scanned} recovered=${recovered} skipped=${skipped} failed=${failed}${dryRun ? ' (dry-run)' : ''}`,
      );
    }

    return { scanned, recovered, skipped, failed, byField, dryRun };
  }
}
