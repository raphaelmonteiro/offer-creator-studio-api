import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { toSql } from 'pgvector/utils';
import { buildEmbeddingText, ProductMetadata } from './metadata/product-metadata.schema';

const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_BATCH_LIMIT = 96;
const DEFAULT_MATCH_THRESHOLD = 0.35;
const BOOTSTRAP_SQL_PATH = path.join(__dirname, '..', 'gallery', 'sql', '001_pgvector_setup.sql');

export interface GalleryEmbeddingMatch {
  id: string;
  filename: string;
  url: string;
  thumbnailUrl: string | null;
  folderId: string | null;
  folderName: string | null;
  distance: number;
}

export interface BackfillResult {
  scanned: number;
  embedded: number;
  failed: number;
}

export interface ProductImageMatchInput {
  id: string;
  name: string;
  category?: string | null;
  unit?: string | null;
}

export interface ProductImageMatchHit {
  productId: string;
  imageId: string;
  imageUrl: string;
  score: number;
}

export interface ProductImageCandidate {
  imageId: string;
  url: string;
  thumbnailUrl: string | null;
  filename: string;
  folderName: string | null;
  score: number;
}

export interface MetadataEmbeddingMatch {
  id: string;
  filename: string;
  url: string;
  thumbnailUrl: string | null;
  folderId: string | null;
  folderName: string | null;
  distance: number;
  metadata: ProductMetadata | null;
}

export type MetadataStatus = 'pending' | 'ready' | 'failed';

@Injectable()
export class GalleryEmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(GalleryEmbeddingService.name);
  private readonly openai: OpenAI | null;
  private readonly embeddingModel: string;
  private readonly enabled: boolean;
  private readonly matchThreshold: number;

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.embeddingModel = this.configService.get<string>(
      'OPENAI_EMBEDDING_MODEL',
      DEFAULT_EMBEDDING_MODEL,
    );
    this.enabled =
      this.configService.get<string>('AI_GALLERY_EMBEDDING_ENABLED', 'true') !== 'false';

    const thresholdRaw = this.configService.get<string>(
      'AI_PRODUCT_IMAGE_MATCH_THRESHOLD',
      String(DEFAULT_MATCH_THRESHOLD),
    );
    const thresholdParsed = Number.parseFloat(thresholdRaw);
    this.matchThreshold =
      Number.isFinite(thresholdParsed) && thresholdParsed >= 0 && thresholdParsed <= 1
        ? thresholdParsed
        : DEFAULT_MATCH_THRESHOLD;

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('AI_GALLERY_EMBEDDING_ENABLED=false — pulando setup do pgvector.');
      return;
    }
    try {
      const sql = fs.readFileSync(BOOTSTRAP_SQL_PATH, 'utf8');
      const statements = sql
        .replace(/^\s*--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        await this.dataSource.query(statement);
      }
      this.logger.log('pgvector pronto (extensão, coluna e índice verificados).');
    } catch (error) {
      this.logger.error(
        `Falha ao preparar pgvector: ${(error as Error).message}. ` +
          'A busca por imagem por similaridade ficará indisponível até resolver.',
      );
    }
  }

  buildIndexableText(filename: string, folderName?: string | null): string {
    const withoutExt = filename.replace(/\.[a-z0-9]+$/i, '');
    const cleaned = withoutExt
      .replace(/[-_.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return folderName ? `${folderName} ${cleaned}`.trim() : cleaned;
  }

  buildProductQueryText(input: {
    name: string;
    category?: string | null;
    unit?: string | null;
  }): string {
    return [input.name, input.category, input.unit]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join(' ')
      .trim();
  }

  async embedText(text: string): Promise<number[] | null> {
    const [result] = await this.embedTexts([text]);
    return result ?? null;
  }

  async embedTexts(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.openai || !this.enabled) {
      return texts.map(() => null);
    }
    if (texts.length === 0) {
      return [];
    }

    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += OPENAI_BATCH_LIMIT) {
      const slice = texts.slice(i, i + OPENAI_BATCH_LIMIT);
      try {
        const response = await this.openai.embeddings.create({
          model: this.embeddingModel,
          input: slice,
        });
        response.data.forEach((item, idx) => {
          results[i + idx] = item.embedding;
        });
      } catch (error) {
        this.logger.error(
          `Falha ao gerar embeddings (batch ${i}-${i + slice.length}): ${(error as Error).message}`,
        );
      }
    }
    return results;
  }

  async updateImageEmbedding(imageId: string, embedding: number[]): Promise<void> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding com ${embedding.length} dimensões; esperado ${EMBEDDING_DIMENSIONS}.`,
      );
    }
    await this.dataSource.query(`UPDATE gallery_images SET embedding = $1::vector WHERE id = $2`, [
      toSql(embedding),
      imageId,
    ]);
  }

  async embedAndStoreForImage(
    imageId: string,
    filename: string,
    folderName?: string | null,
  ): Promise<boolean> {
    if (!this.openai || !this.enabled) return false;
    const text = this.buildIndexableText(filename, folderName);
    if (!text) return false;
    const embedding = await this.embedText(text);
    if (!embedding) return false;
    await this.updateImageEmbedding(imageId, embedding);
    return true;
  }

  async backfillEmbeddings(batchSize = 100): Promise<BackfillResult> {
    const result: BackfillResult = { scanned: 0, embedded: 0, failed: 0 };
    if (!this.openai || !this.enabled) {
      this.logger.warn('backfillEmbeddings: OpenAI não configurado ou feature desabilitada.');
      return result;
    }

    while (true) {
      const rows: Array<{
        id: string;
        filename: string;
        folderName: string | null;
      }> = await this.dataSource.query(
        `SELECT gi.id, gi.filename, gf.name AS "folderName"
           FROM gallery_images gi
           LEFT JOIN gallery_folders gf ON gf.id = gi."folderId"
          WHERE gi.embedding IS NULL
          ORDER BY gi."createdAt" ASC
          LIMIT $1`,
        [batchSize],
      );

      if (rows.length === 0) break;
      result.scanned += rows.length;

      const texts = rows.map((row) => this.buildIndexableText(row.filename, row.folderName));
      const embeddings = await this.embedTexts(texts);

      for (let i = 0; i < rows.length; i++) {
        const embedding = embeddings[i];
        if (!embedding) {
          result.failed += 1;
          continue;
        }
        try {
          await this.updateImageEmbedding(rows[i].id, embedding);
          result.embedded += 1;
        } catch (error) {
          this.logger.error(
            `Falha ao salvar embedding da imagem ${rows[i].id}: ${(error as Error).message}`,
          );
          result.failed += 1;
        }
      }

      this.logger.log(
        `Backfill: scanned=${result.scanned} embedded=${result.embedded} failed=${result.failed}`,
      );

      if (rows.length < batchSize) break;
    }

    return result;
  }

  async findBestImageMatches(
    products: ProductImageMatchInput[],
  ): Promise<{ matches: ProductImageMatchHit[]; scanned: number; matched: number }> {
    const scanned = products.length;
    if (!this.openai || !this.enabled || scanned === 0) {
      return { matches: [], scanned, matched: 0 };
    }

    const queryTexts = products.map((p) => this.buildProductQueryText(p));
    const embeddings = await this.embedTexts(queryTexts);

    const matches: ProductImageMatchHit[] = [];
    for (let i = 0; i < products.length; i++) {
      const embedding = embeddings[i];
      if (!embedding) continue;

      const [best] = await this.searchByEmbedding(embedding, 1);
      if (!best) continue;

      const score = 1 - best.distance;
      if (score < this.matchThreshold) continue;

      matches.push({
        productId: products[i].id,
        imageId: best.id,
        imageUrl: best.url,
        score,
      });
    }

    return { matches, scanned, matched: matches.length };
  }

  async findImageCandidatesForProduct(input: {
    name: string;
    category?: string | null;
    unit?: string | null;
    limit?: number;
  }): Promise<ProductImageCandidate[]> {
    if (!this.openai || !this.enabled) return [];
    const queryText = this.buildProductQueryText(input);
    if (!queryText) return [];
    const embedding = await this.embedText(queryText);
    if (!embedding) return [];
    const limit = Math.min(Math.max(input.limit ?? 12, 1), 48);
    const matches = await this.searchByEmbedding(embedding, limit);
    return matches.map((m) => ({
      imageId: m.id,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      filename: m.filename,
      folderName: m.folderName,
      score: 1 - m.distance,
    }));
  }

  async setMetadataStatus(
    imageId: string,
    status: MetadataStatus,
    errorMessage?: string | null,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE gallery_images SET metadata_status = $1, metadata_error = $2 WHERE id = $3`,
      [status, status === 'failed' ? (errorMessage ?? null) : null, imageId],
    );
  }

  async saveImageMetadata(imageId: string, metadata: ProductMetadata): Promise<void> {
    await this.dataSource.query(
      `UPDATE gallery_images
          SET metadata = $1::jsonb,
              metadata_status = 'ready',
              metadata_error = NULL
        WHERE id = $2`,
      [JSON.stringify(metadata), imageId],
    );
  }

  async updateMetadataEmbedding(imageId: string, embedding: number[]): Promise<void> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding com ${embedding.length} dimensões; esperado ${EMBEDDING_DIMENSIONS}.`,
      );
    }
    await this.dataSource.query(
      `UPDATE gallery_images SET metadata_embedding = $1::vector WHERE id = $2`,
      [toSql(embedding), imageId],
    );
  }

  /**
   * After metadata is extracted, derive the canonical text and embed it into
   * the `metadata_embedding` vector used by the V2 matcher.
   */
  async embedAndStoreMetadataForImage(
    imageId: string,
    metadata: ProductMetadata,
  ): Promise<boolean> {
    if (!this.openai || !this.enabled) return false;
    const text = buildEmbeddingText(metadata);
    if (!text) return false;
    const embedding = await this.embedText(text);
    if (!embedding) return false;
    await this.updateMetadataEmbedding(imageId, embedding);
    return true;
  }

  /**
   * Backfill helper: yields images that still need metadata extracted. Used
   * by the admin backfill endpoint.
   */
  async listImagesPendingMetadata(
    limit: number,
    includeFailed = false,
  ): Promise<Array<{ id: string; url: string }>> {
    return this.dataSource.query(
      `SELECT id, url
         FROM gallery_images
        WHERE metadata_status IS NULL
           OR metadata_status = 'pending'
           ${includeFailed ? `OR metadata_status = 'failed'` : ''}
        ORDER BY "createdAt" ASC
        LIMIT $1`,
      [limit],
    );
  }

  /**
   * Lists images stuck in `metadata_status = 'failed'` along with the last
   * error message, so the admin backfill can be targeted/inspected.
   */
  async listFailedMetadataImages(
    limit: number,
    offset: number,
  ): Promise<
    Array<{
      id: string;
      filename: string;
      url: string;
      metadataError: string | null;
      updatedAt: Date;
    }>
  > {
    return this.dataSource.query(
      `SELECT id, filename, url, metadata_error AS "metadataError", "updatedAt"
         FROM gallery_images
        WHERE metadata_status = 'failed'
        ORDER BY "updatedAt" DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  /**
   * Cosine-distance search over `metadata_embedding`. Returns the raw metadata
   * jsonb alongside each row so the V2 matcher can run the hybrid score
   * without a second roundtrip per candidate.
   */
  async searchByMetadataEmbedding(
    embedding: number[],
    limit = 15,
  ): Promise<MetadataEmbeddingMatch[]> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding com ${embedding.length} dimensões; esperado ${EMBEDDING_DIMENSIONS}.`,
      );
    }
    const rows: Array<{
      id: string;
      filename: string;
      url: string;
      thumbnailUrl: string | null;
      folderId: string | null;
      folderName: string | null;
      distance: string;
      metadata: ProductMetadata | null;
    }> = await this.dataSource.query(
      `SELECT gi.id,
              gi.filename,
              gi.url,
              gi."thumbnailUrl",
              gi."folderId",
              gf.name AS "folderName",
              (gi.metadata_embedding <=> $1::vector) AS distance,
              gi.metadata
         FROM gallery_images gi
         LEFT JOIN gallery_folders gf ON gf.id = gi."folderId"
        WHERE gi.metadata_embedding IS NOT NULL
        ORDER BY gi.metadata_embedding <=> $1::vector
        LIMIT $2`,
      [toSql(embedding), limit],
    );

    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      url: row.url,
      thumbnailUrl: row.thumbnailUrl,
      folderId: row.folderId,
      folderName: row.folderName,
      distance: Number(row.distance),
      metadata: row.metadata ?? null,
    }));
  }

  async searchByEmbedding(embedding: number[], limit = 12): Promise<GalleryEmbeddingMatch[]> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding com ${embedding.length} dimensões; esperado ${EMBEDDING_DIMENSIONS}.`,
      );
    }
    const rows: Array<{
      id: string;
      filename: string;
      url: string;
      thumbnailUrl: string | null;
      folderId: string | null;
      folderName: string | null;
      distance: string;
    }> = await this.dataSource.query(
      `SELECT gi.id,
              gi.filename,
              gi.url,
              gi."thumbnailUrl",
              gi."folderId",
              gf.name AS "folderName",
              (gi.embedding <=> $1::vector) AS distance
         FROM gallery_images gi
         LEFT JOIN gallery_folders gf ON gf.id = gi."folderId"
        WHERE gi.embedding IS NOT NULL
        ORDER BY gi.embedding <=> $1::vector
        LIMIT $2`,
      [toSql(embedding), limit],
    );

    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      url: row.url,
      thumbnailUrl: row.thumbnailUrl,
      folderId: row.folderId,
      folderName: row.folderName,
      distance: Number(row.distance),
    }));
  }
}
