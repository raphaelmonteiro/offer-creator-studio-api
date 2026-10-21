import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isValidGtin } from '../ai/ean/gtin.util';
import {
  canOverwriteEan,
  EanSource,
  EanSourceSchema,
  ProductMetadata,
} from '../ai/metadata/product-metadata.schema';

/** EAN como a resolução do encarte grava e procura (13 dígitos quando possível). */
export function canonicalEan(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  if (!isValidGtin(digits)) return null;
  if (digits.length === 12) return `0${digits}`;
  if (digits.length === 14 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/** `7891000100103`, `07891000100103` e `007891000100103` são o mesmo GTIN. */
function sameGtin(a: string, b: string): boolean {
  return a.replace(/^0+/, '') === b.replace(/^0+/, '');
}

export type ManualEanLinkStatus = 'linked' | 'unchanged' | 'replaced' | 'kept';

export interface ManualEanLinkPlan {
  status: ManualEanLinkStatus;
  /** Metadata a gravar; `null` quando nada muda. */
  metadata: Record<string, unknown> | null;
  previousEan: string | null;
  previousSource: string | null;
}

/**
 * Decide o que gravar quando um humano diz, escolhendo a foto de um produto do
 * encarte, "esta imagem é deste EAN".
 *
 * - imagem sem EAN → recebe o EAN com fonte `manual` / `human`;
 * - imagem já com o mesmo EAN (qualquer fonte) → nada muda: não vale trocar a
 *   proveniência de uma foto exata da DotCompany só para carimbar o humano;
 * - imagem com EAN diferente → vale a precedência de `canOverwriteEan`: a
 *   escolha humana (`manual`) vence todas as fontes, inclusive outra escolha
 *   humana anterior (a última decisão vale). O EAN anterior fica registrado
 *   em `eanCandidates` e em `warnings` para a trilha de auditoria.
 */
export function planManualEanLink(
  current: Record<string, unknown> | null | undefined,
  ean: string,
  context: { productName?: string | null; now?: string } = {},
): ManualEanLinkPlan {
  const meta = (current ?? {}) as Partial<ProductMetadata> & Record<string, unknown>;
  const previousEan = typeof meta.ean === 'string' && meta.ean ? meta.ean : null;
  const previousSource = typeof meta.eanSource === 'string' ? meta.eanSource : null;

  if (previousEan && sameGtin(previousEan, ean)) {
    return { status: 'unchanged', metadata: null, previousEan, previousSource };
  }

  const currentSource = EanSourceSchema.safeParse(previousSource);
  if (previousEan && currentSource.success && !canOverwriteEan(currentSource.data, 'manual')) {
    return { status: 'kept', metadata: null, previousEan, previousSource };
  }

  const now = context.now ?? new Date().toISOString();
  const productName = context.productName?.trim();
  const warnings = Array.isArray(meta.warnings)
    ? meta.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  const nextWarnings = [...warnings];
  const linkNote = `ean-manual: escolhida no encarte${productName ? ` "${productName.slice(0, 60)}"` : ''}`;
  if (!nextWarnings.includes(linkNote)) nextWarnings.push(linkNote);

  const candidates = Array.isArray(meta.eanCandidates) ? [...meta.eanCandidates] : [];
  if (previousEan) {
    nextWarnings.push(`ean-anterior:${previousEan}${previousSource ? `:${previousSource}` : ''}`);
    if (currentSource.success) {
      candidates.push({
        ean: previousEan,
        source: currentSource.data as EanSource,
        score: typeof meta.eanConfidence === 'number' ? meta.eanConfidence : 0.5,
        description: 'substituído pela escolha no encarte',
      });
    }
  }

  const metadata: Record<string, unknown> = {
    ...meta,
    ean,
    eanSource: 'manual',
    eanConfidence: 1,
    eanVerifiedAt: now,
    eanStatus: 'resolved',
    eanVerifiedBy: 'human',
    eanJobId: null,
    warnings: nextWarnings,
  };
  if (candidates.length) metadata.eanCandidates = candidates;

  return {
    status: previousEan ? 'replaced' : 'linked',
    metadata,
    previousEan,
    previousSource,
  };
}

export interface ManualEanLinkResult {
  imageId: string;
  ean: string;
  status: ManualEanLinkStatus;
  previousEan: string | null;
  previousSource: string | null;
}

/**
 * Vínculo EAN↔imagem feito pelo usuário ao escolher a foto de um produto do
 * encarte. Na próxima lista com o mesmo EAN, `FlyerEanResolutionService`
 * encontra a foto pelo `metadata->>'ean'` antes de qualquer busca por nome.
 *
 * SQL cru via DataSource, como o `ClientPreferredImagesService`: o `metadata`
 * de `gallery_images` é gerenciado por SQL, não pela entidade.
 */
@Injectable()
export class GalleryImageEanService {
  private readonly logger = new Logger(GalleryImageEanService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async linkEan(
    imageId: string,
    rawEan: string,
    context: { productName?: string | null } = {},
  ): Promise<ManualEanLinkResult> {
    const ean = canonicalEan(rawEan);
    if (!ean) {
      throw new UnprocessableEntityException({
        code: 'EAN_INVALID',
        message: 'EAN inválido: use 8, 12, 13 ou 14 dígitos com dígito verificador correto.',
      });
    }

    const plan = await this.dataSource.transaction(async (manager) => {
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

      const decision = planManualEanLink(rows[0].metadata, ean, context);
      if (decision.metadata) {
        await manager.query(`UPDATE gallery_images SET metadata = $1::jsonb WHERE id = $2`, [
          JSON.stringify(decision.metadata),
          imageId,
        ]);
      }
      return decision;
    });

    if (plan.status === 'replaced') {
      this.logger.log(
        `Imagem ${imageId}: EAN ${plan.previousEan} (${plan.previousSource ?? 'sem fonte'}) substituído por ${ean} pela escolha no encarte`,
      );
    }

    return {
      imageId,
      ean,
      status: plan.status,
      previousEan: plan.previousEan,
      previousSource: plan.previousSource,
    };
  }
}
