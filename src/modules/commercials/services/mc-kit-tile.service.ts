import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as sharp from 'sharp';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { KIT_TILE_BACKGROUND_DEFAULT } from '../domain/kit-prompts';
import { McNormalizedBox } from '../domain/mc-mouth-gate';
import {
  computeTileCrop,
  edgeUniformity,
  keyEdgeBackground,
  MC_TILE_EDGE_TOLERANCE,
  McEdgeKeyResult,
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
 *
 * O fundo liso detectado na borda vira TRANSPARÊNCIA real (inundação a
 * partir das bordas, domain/mc-tile `keyEdgeBackground`): o tile de fala
 * recolore o fundo com `flatten`, que só enxerga alfa — um tile opaco cinza
 * ficaria cinza em qualquer janela. `backgroundColor` segue como a cor de
 * exibição padrão; `detectedBackgroundColor` guarda a cor que foi removida.
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
    // Identidade gerada sem caixa do rosto: a imagem inteira não é um tile
    // (rosto ≥ 60% da altura é a regra) — só o logo como está pode cair
    // para o logo inteiro, porque ali o "personagem" É a marca.
    if (!bbox && kit.identityMode !== 'logo_as_is') {
      throw new UnprocessableEntityException({
        code: 'TILE_FACE_NOT_FOUND',
        message:
          'O gate de boca não localizou o rosto da identidade — sem a caixa do rosto o tile ' +
          'não pode ser recortado. Gere uma variante com boca ou escolha outro candidato.',
        details: { actions: ['mouth_variant', 'choose_candidate'] },
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

    // Raster do tile: extract → extend transparente → resize → RGBA cru. O
    // fundo opaco detectado é inundado para alfa 0 a partir das bordas (os
    // pixels da mesma cor no interior do personagem sobrevivem).
    const { data, info } = await sharp(source)
      .ensureAlpha()
      .extract(plan.extract)
      .extend({ ...plan.extend, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(plan.output.width, plan.output.height, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const keying: McEdgeKeyResult | null = uniformity.transparent
      ? null
      : keyEdgeBackground(
          { data, width: info.width, height: info.height, channels: 4 },
          uniformity.background,
          MC_TILE_EDGE_TOLERANCE,
        );
    const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer();
    const backgroundColor = this.resolveBackgroundColor(kit, uniformity);

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
      // sempre com alfa: já transparente na origem, ou com o fundo liso inundado
      hasAlpha: true,
      fileSize: String(png.length),
      metadata: {
        kitId: kit.id,
        identityAssetId: identity.id,
        identityMode: kit.identityMode,
        bbox,
        faceFraction: plan.faceFraction,
        ratio: Number(plan.ratio.toFixed(4)),
        backgroundColor,
        detectedBackgroundColor: uniformity.hex,
        keyedBackground: keying ? { keyed: keying.keyed, ramped: keying.ramped } : null,
        edge: uniformity.fractions,
      },
    });
    this.logger.log(
      `Kit ${kit.id}: tile ${plan.output.width}×${plan.output.height} (rosto ${
        plan.faceFraction == null ? 'n/d' : `${Math.round(plan.faceFraction * 100)}%`
      }, fundo ${backgroundColor}${
        keying ? `, ${uniformity.hex} removido em ${keying.keyed} px` : ', origem transparente'
      })`,
    );
    return {
      assetId: asset.id,
      url,
      width: plan.output.width,
      height: plan.output.height,
      ratio: plan.ratio,
      faceFraction: plan.faceFraction,
      backgroundColor,
      hasAlpha: true,
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
   * Cor de fundo padrão do tile (spec "Logo usado como está"): em `logo_as_is`
   * é o fundo do próprio logo ou, quando o logo é transparente, a cor de marca
   * do kit (`tileBackgroundColor`: a pedida na criação, senão o cinza claro
   * padrão) — nunca a cor dominante do próprio logo, que apagaria a marca no
   * tile achatado. Em `generated` vale a cor do kit (pedida no prompt), senão a
   * borda detectada, senão o cinza claro padrão.
   */
  private resolveBackgroundColor(kit: McCharacterKit, uniformity: McEdgeUniformity): string {
    if (kit.identityMode === 'logo_as_is') {
      return uniformity.hex ?? kit.tileBackgroundColor ?? KIT_TILE_BACKGROUND_DEFAULT;
    }
    return kit.tileBackgroundColor ?? uniformity.hex ?? KIT_TILE_BACKGROUND_DEFAULT;
  }
}
