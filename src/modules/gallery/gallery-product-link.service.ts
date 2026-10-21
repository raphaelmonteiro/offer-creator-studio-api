import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { canonicalEan, ManualEanLinkStatus, planManualEanLink } from './gallery-image-ean.service';
import { addProductAlias } from './product-alias';

export interface ProductLinkResult {
  imageId: string;
  /** Nome gravado na imagem (chave normalizada) e se é novo nela. */
  alias: { key: string; added: boolean };
  /** Resultado do EAN; `null` quando a lista não trouxe EAN; `invalid` quando veio mas não fecha o dígito. */
  ean:
    | { ean: string; status: ManualEanLinkStatus; previousEan: string | null }
    | { ean: string; status: 'invalid' }
    | null;
}

/**
 * Vínculo imagem ↔ produto feito pelo usuário ao escolher a foto de um produto
 * do encarte: grava na imagem o NOME do produto (sempre) e o EAN (quando a
 * lista trouxe). Na próxima lista, `FlyerEanResolutionService` encontra a foto
 * pelo EAN ou pelo nome antes da busca por nome com IA.
 *
 * Uma escrita só, em transação com a linha travada, para o bloco EAN e a lista
 * de nomes não se sobrescreverem entre duas escolhas simultâneas.
 */
@Injectable()
export class GalleryProductLinkService implements OnModuleInit {
  private readonly logger = new Logger(GalleryProductLinkService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      // Busca por nome: `metadata->'aliases' @> '[{"key": "..."}]'` usa este índice.
      await this.dataSource.query(
        `CREATE INDEX IF NOT EXISTS idx_gallery_images_aliases
           ON gallery_images USING gin ((metadata->'aliases') jsonb_path_ops)`,
      );
    } catch (error) {
      this.logger.warn(`Falha ao criar índice de nomes da galeria: ${(error as Error).message}`);
    }
  }

  async linkProduct(
    imageId: string,
    input: { productName: string; ean?: string | null },
  ): Promise<ProductLinkResult> {
    const rawEan = input.ean?.trim() || null;
    const ean = rawEan ? canonicalEan(rawEan) : null;

    return this.dataSource.transaction(async (manager) => {
      const rows: Array<{ metadata: Record<string, unknown> | null }> = await manager.query(
        `SELECT metadata FROM gallery_images WHERE id = $1 FOR UPDATE`,
        [imageId],
      );
      if (rows.length === 0) {
        throw new NotFoundException({
          code: 'GALLERY_IMAGE_NOT_FOUND',
          message: 'Imagem não encontrada',
        });
      }

      let metadata = rows[0].metadata;
      let changed = false;
      let eanResult: ProductLinkResult['ean'] = null;
      if (ean) {
        const plan = planManualEanLink(metadata, ean, { productName: input.productName });
        if (plan.metadata) {
          metadata = plan.metadata;
          changed = true;
        }
        eanResult = { ean, status: plan.status, previousEan: plan.previousEan };
        if (plan.status === 'replaced') {
          this.logger.log(
            `Imagem ${imageId}: EAN ${plan.previousEan} (${plan.previousSource ?? 'sem fonte'}) substituído por ${ean} pela escolha no encarte`,
          );
        }
      } else if (rawEan) {
        eanResult = { ean: rawEan, status: 'invalid' };
      }

      // O nome entra sempre (nome repetido só renova a data da escolha).
      const alias = addProductAlias(metadata, input.productName);
      if (alias) {
        metadata = alias.metadata;
        changed = true;
      }

      if (changed && metadata) {
        await manager.query(`UPDATE gallery_images SET metadata = $1::jsonb WHERE id = $2`, [
          JSON.stringify(metadata),
          imageId,
        ]);
      }

      return {
        imageId,
        alias: alias ? { key: alias.key, added: alias.added } : { key: '', added: false },
        ean: eanResult,
      };
    });
  }
}
