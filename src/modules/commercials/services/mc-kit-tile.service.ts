import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as sharp from 'sharp';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { KIT_TILE_BACKGROUND_DEFAULT } from '../domain/kit-prompts';
import { McNormalizedBox } from '../domain/mc-mouth-gate';
import {
  computeTileCrop,
  dominantOpaqueColor,
  edgeUniformity,
  McEdgeUniformity,
  McTileCropPlan,
} from '../domain/mc-tile';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McStorageService } from './mc-storage.service';

export interface McKitTileResult {
  assetId: string;
  url: string;
  width: number;
  height: number;
  ratio: number;
  faceFraction: number | null;
  backgroundColor: string;
  hasAlpha: boolean;
}

/** Lado da amostra em que a borda é inspecionada (limita memória em identidades grandes). */
const EDGE_SAMPLE_SIZE = 256;

/**
 * Tile do personagem (D1 / spec "Tile do personagem"): recorte da identidade
 * pela caixa do rosto (gate de boca), com rosto ≥ 60% da altura, proporção
 * 3:4..1:1, ≥ 720 px no lado menor, alfa preservado. Guarda de uniformidade
 * da borda ANTES de aceitar: fundo não liso (gradiente, cenário) reprova com
 * 422 TILE_BORDER_NOT_UNIFORM e o kit fica em revisão. Em `logo_as_is` o
 * recorte é dos pixels originais do logo — nenhuma regeneração.
 */
@Injectable()
export class McKitTileService {
  private readonly logger = new Logger(McKitTileService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: McStorageService,
  ) {}

  async build(
    kit: McCharacterKit,
    identity: AnimationAsset,
    bbox: McNormalizedBox | null,
  ): Promise<McKitTileResult> {
    const source = identity.fileUrl ? await this.storage.readUploadsFile(identity.fileUrl) : null;
    if (!source) {
      throw new UnprocessableEntityException({
        code: 'KIT_IDENTITY_FILE_MISSING',
        message:
          'A imagem da identidade do kit não foi encontrada no servidor. Escolha outra ' +
          'identidade ou regenere a referência frontal.',
      });
    }
    const meta = await sharp(source).metadata();
    if (!meta.width || !meta.height) {
      throw new UnprocessableEntityException({
        code: 'KIT_IDENTITY_FILE_INVALID',
        message: 'A imagem da identidade do kit não pôde ser lida.',
      });
    }
    let plan = computeTileCrop({ width: meta.width, height: meta.height, bbox });
    let uniformity = await this.inspectBorder(source, plan);
    // Logo como está: se o recorte pelo rosto corta o próprio logo (marca,
    // letras em volta do rosto), o tile volta a ser o logo INTEIRO — ainda os
    // pixels originais, com a margem do próprio logo como borda.
    if (!uniformity.uniform && kit.identityMode === 'logo_as_is' && bbox) {
      this.logger.log(`Kit ${kit.id}: recorte pelo rosto corta o logo — tile com o logo inteiro.`);
      plan = computeTileCrop({ width: meta.width, height: meta.height, bbox: null });
      uniformity = await this.inspectBorder(source, plan);
    }
    if (!uniformity.uniform) {
      throw new UnprocessableEntityException({
        code: 'TILE_BORDER_NOT_UNIFORM',
        message:
          'O fundo em volta do personagem não é liso (gradiente, cenário ou o personagem ' +
          'encosta na borda). Escolha outra identidade ou gere uma variante antes de aprovar.',
        details: { fractions: uniformity.fractions, faceFraction: plan.faceFraction },
      });
    }

    const background = uniformity.transparent
      ? { r: 0, g: 0, b: 0, alpha: 0 }
      : { ...uniformity.background, alpha: 1 };
    const png = await sharp(source)
      .ensureAlpha()
      .extract(plan.extract)
      .extend({ ...plan.extend, background })
      .resize(plan.output.width, plan.output.height, { fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer();
    const backgroundColor = await this.resolveBackgroundColor(kit, uniformity, source);

    const url = await this.storage.saveFile(
      `commercials/kits/${kit.id}`,
      `tile-${Date.now()}.png`,
      png,
    );
    const asset = await this.dataSource.getRepository(AnimationAsset).save({
      userId: kit.userId,
      kind: 'kit_tile' as const,
      status: 'ready' as const,
      name: `Tile do kit ${kit.id.slice(0, 8)}`,
      origin: kit.identityMode === 'logo_as_is' ? ('imported' as const) : ('ai_generated' as const),
      fileUrl: url,
      mimeType: 'image/png',
      width: plan.output.width,
      height: plan.output.height,
      hasAlpha: uniformity.transparent,
      fileSize: String(png.length),
      metadata: {
        kitId: kit.id,
        identityAssetId: identity.id,
        identityMode: kit.identityMode,
        bbox,
        faceFraction: plan.faceFraction,
        ratio: Number(plan.ratio.toFixed(4)),
        backgroundColor,
        edge: uniformity.fractions,
      },
    });
    this.logger.log(
      `Kit ${kit.id}: tile ${plan.output.width}×${plan.output.height} (rosto ${
        plan.faceFraction == null ? 'n/d' : `${Math.round(plan.faceFraction * 100)}%`
      }, fundo ${backgroundColor})`,
    );
    return {
      assetId: asset.id,
      url,
      width: plan.output.width,
      height: plan.output.height,
      ratio: plan.ratio,
      faceFraction: plan.faceFraction,
      backgroundColor,
      hasAlpha: uniformity.transparent,
    };
  }

  /** Tile anterior descartado quando a identidade muda (spec "Identidade alterada"). */
  async discard(manager: EntityManager, tileAssetId: string | null): Promise<void> {
    if (!tileAssetId) return;
    await manager.softDelete(AnimationAsset, tileAssetId);
  }

  /** Borda amostrada sobre a região extraída, reduzida a 256×256 (só a uniformidade importa). */
  private async inspectBorder(source: Buffer, plan: McTileCropPlan): Promise<McEdgeUniformity> {
    const { data, info } = await sharp(source)
      .ensureAlpha()
      .extract(plan.extract)
      .resize(EDGE_SAMPLE_SIZE, EDGE_SAMPLE_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return edgeUniformity({
      data,
      width: info.width,
      height: info.height,
      channels: info.channels as 3 | 4,
    });
  }

  /**
   * Cor de fundo padrão do tile: em `logo_as_is` é o fundo do próprio logo
   * (ou a cor dominante — "cor de marca" — quando o logo é transparente); em
   * `generated` vale a cor do kit (pedida no prompt), senão a borda detectada,
   * senão o cinza claro padrão.
   */
  private async resolveBackgroundColor(
    kit: McCharacterKit,
    uniformity: McEdgeUniformity,
    source: Buffer,
  ): Promise<string> {
    if (kit.identityMode === 'logo_as_is') {
      if (uniformity.hex) return uniformity.hex;
      const dominant = await this.dominantHex(source);
      return dominant ?? kit.tileBackgroundColor ?? KIT_TILE_BACKGROUND_DEFAULT;
    }
    return kit.tileBackgroundColor ?? uniformity.hex ?? KIT_TILE_BACKGROUND_DEFAULT;
  }

  /** "Cor de marca" de um logo transparente: dominante entre os pixels opacos (amostra 64×64). */
  private async dominantHex(source: Buffer): Promise<string | null> {
    try {
      const { data, info } = await sharp(source)
        .ensureAlpha()
        .resize(64, 64, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      return dominantOpaqueColor({
        data,
        width: info.width,
        height: info.height,
        channels: info.channels as 3 | 4,
      });
    } catch {
      return null;
    }
  }
}
