import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as sharp from 'sharp';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McBodyTilePlan, planBodyTile } from '../domain/mc-body-tile';
import { chooseCutoutKey, McCutoutKeyDecision } from '../domain/mc-cutout-key';
import { McNormalizedBox } from '../domain/mc-mouth-gate';
import {
  edgeUniformity,
  keyEdgeBackground,
  MC_TILE_EDGE_TOLERANCE,
  McEdgeUniformity,
} from '../domain/mc-tile';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McStorageService } from './mc-storage.service';

const EDGE_SAMPLE_SIZE = 256;
const KEY_SAMPLE_SIZE = 512;
/** Anel (px) de alfa zerado nas bordas de cima e dos lados do tile final: ruído nunca encosta. */
const EDGE_CLEAR_PX = 2;

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Tile de corpo do kit (video-mascote-transparente, D4): derivado da identidade
 * já aprovada, só com sharp (custo zero, nenhuma chamada paga). Idempotente: se
 * o kit já tem o tile da mesma identidade, devolve o existente; a gravacao usa
 * UPDATE condicional para duas abas não duplicarem.
 */
@Injectable()
export class McKitBodyTileService {
  private readonly logger = new Logger(McKitBodyTileService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: McStorageService,
  ) {}

  /** Garante o tile de corpo do kit aprovado e devolve o asset (já gravado em `bodyTileAssetId`). */
  async ensure(kit: McCharacterKit): Promise<AnimationAsset> {
    const assets = this.dataSource.getRepository(AnimationAsset);
    const tile = kit.tileAssetId ? await assets.findOneBy({ id: kit.tileAssetId }) : null;
    if (!tile) {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_APPROVED',
        message: 'O kit ainda não tem o tile do personagem: aprove o kit antes de usar o corpo.',
      });
    }
    const identityId = String(tile.metadata?.identityAssetId ?? '');
    if (kit.bodyTileAssetId) {
      const existing = await assets.findOneBy({ id: kit.bodyTileAssetId });
      const reusable =
        existing &&
        (existing.id === tile.id || existing.metadata?.identityAssetId === identityId) &&
        existing.metadata?.cutoutKey;
      if (reusable) return existing;
    }
    if (kit.identityMode === 'logo_as_is') return this.useLogoAsBody(kit, tile);
    const identity = identityId ? await assets.findOneBy({ id: identityId }) : null;
    return this.buildBody(kit, tile, identity);
  }

  /** Logo como está: o "corpo" é o próprio tile; só a chave é calculada (aviso LOGO_AS_IS_NO_BODY). */
  private async useLogoAsBody(kit: McCharacterKit, tile: AnimationAsset): Promise<AnimationAsset> {
    const source = tile.fileUrl ? await this.storage.readUploadsFile(tile.fileUrl) : null;
    if (!source) throw this.identityMissing();
    const raw = await this.readRaw(source);
    const cutoutKey = await this.decideKey(raw);
    const repo = this.dataSource.getRepository(AnimationAsset);
    tile.metadata = { ...tile.metadata, cutoutKey };
    await repo.update({ id: tile.id }, { metadata: tile.metadata });
    return this.claim(kit, tile);
  }

  private async buildBody(
    kit: McCharacterKit,
    tile: AnimationAsset,
    identity: AnimationAsset | null,
  ): Promise<AnimationAsset> {
    const source = identity?.fileUrl ? await this.storage.readUploadsFile(identity.fileUrl) : null;
    if (!identity || !source) throw this.identityMissing();
    const bbox = (tile.metadata?.bbox ?? null) as McNormalizedBox | null;
    if (!bbox) {
      throw new UnprocessableEntityException({
        code: 'TILE_FACE_NOT_FOUND',
        message: 'O tile do personagem não tem a caixa do rosto: o corpo não pode ser recortado.',
        details: { actions: ['use_bust'] },
      });
    }
    const raw = await this.readRaw(source);
    const uniformity = await this.assertBorder(raw);
    this.keyBackground(raw, uniformity);
    const alpha = new Uint8Array(raw.width * raw.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = raw.data[i * 4 + 3];
    const result = planBodyTile({ width: raw.width, height: raw.height, alpha, bbox });
    if ('code' in result) {
      throw new UnprocessableEntityException({
        code: result.code,
        message: 'Não foi possível encontrar a personagem na imagem da identidade.',
        details: { actions: ['use_bust'] },
      });
    }
    const png = await this.renderTile(raw, result.plan);
    const cutoutKey = await this.decideKey(raw);
    const url = await this.storage.saveFile(
      `commercials/kits/${kit.id}`,
      `tile-corpo-${Date.now()}.png`,
      png,
    );
    const plan = result.plan;
    const created = await this.dataSource.getRepository(AnimationAsset).save({
      userId: kit.userId,
      kind: 'kit_tile' as const,
      status: 'ready' as const,
      name: `Tile de corpo do kit ${kit.id.slice(0, 8)}`,
      origin: 'ai_generated' as const,
      fileUrl: url,
      mimeType: 'image/png',
      width: plan.output.width,
      height: plan.output.height,
      hasAlpha: true,
      fileSize: String(png.length),
      metadata: {
        kitId: kit.id,
        identityAssetId: identity.id,
        identityMode: kit.identityMode,
        framing: 'body',
        bbox,
        figure: plan.figure,
        margin: plan.margin,
        cutAtBottom: plan.cutAtBottom,
        faceFraction: plan.faceFraction,
        ratio: Number(plan.ratio.toFixed(4)),
        warnings: plan.warnings,
        detectedBackgroundColor: uniformity.hex,
        cutoutKey,
      },
    });
    this.logger.log(
      `Kit ${kit.id}: tile de corpo ${plan.output.width}x${plan.output.height} (rosto ${Math.round(
        plan.faceFraction * 100,
      )}%, chave ${cutoutKey.chosen ?? 'nenhuma segura'})`,
    );
    return this.claim(kit, created);
  }

  /** Grava `bodyTileAssetId` só se ainda não há outro válido; quem perde a corrida descarta o seu. */
  private async claim(kit: McCharacterKit, asset: AnimationAsset): Promise<AnimationAsset> {
    const repo = this.dataSource.getRepository(McCharacterKit);
    const result = await repo
      .createQueryBuilder()
      .update(McCharacterKit)
      .set({ bodyTileAssetId: asset.id })
      .where('id = :id AND ("bodyTileAssetId" IS NULL OR "bodyTileAssetId" = :old)', {
        id: kit.id,
        old: kit.bodyTileAssetId ?? '00000000-0000-0000-0000-000000000000',
      })
      .execute();
    if (result.affected) {
      kit.bodyTileAssetId = asset.id;
      return asset;
    }
    const current = await repo.findOneByOrFail({ id: kit.id });
    const assets = this.dataSource.getRepository(AnimationAsset);
    if (asset.id !== kit.tileAssetId) await assets.softDelete(asset.id);
    return assets.findOneByOrFail({ id: current.bodyTileAssetId as string });
  }

  private async readRaw(source: Buffer): Promise<RawImage> {
    const { data, info } = await sharp(source)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height) {
      throw new UnprocessableEntityException({
        code: 'KIT_IDENTITY_FILE_INVALID',
        message: 'A imagem da identidade do kit não pôde ser lida.',
      });
    }
    return { data, width: info.width, height: info.height };
  }

  /** Borda de cima e laterais livres (o corpo pode sair por baixo): senão 422 com saída "busto". */
  private async assertBorder(raw: RawImage): Promise<McEdgeUniformity> {
    const sample = await sharp(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    })
      .resize(EDGE_SAMPLE_SIZE, EDGE_SAMPLE_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const uniformity = edgeUniformity(
      { data: sample.data, width: sample.info.width, height: sample.info.height, channels: 4 },
      { bodyMayCrossSides: true },
    );
    if (uniformity.uniform) return uniformity;
    throw new UnprocessableEntityException({
      code: 'BODY_TILE_BORDER_NOT_UNIFORM',
      message:
        'O fundo da identidade não é liso (gradiente, cenário ou a cabeça encosta na borda): ' +
        'não dá para recortar o corpo. Use o enquadramento de busto.',
      details: { fractions: uniformity.fractions, actions: ['use_bust'] },
    });
  }

  /** Fundo liso vira alfa (mesma inundação do tile de busto); no-op se a identidade já é transparente. */
  private keyBackground(raw: RawImage, uniformity: McEdgeUniformity): void {
    if (uniformity.transparent) return;
    keyEdgeBackground(
      { data: raw.data, width: raw.width, height: raw.height, channels: 4 },
      uniformity.background,
      MC_TILE_EDGE_TOLERANCE,
    );
  }

  private async renderTile(raw: RawImage, plan: McBodyTilePlan): Promise<Buffer> {
    const { data, info } = await sharp(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    })
      .extract(plan.extract)
      .extend({ ...plan.extend, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(plan.output.width, plan.output.height, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    this.clearEdges(data, info.width, info.height);
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer();
  }

  /** Nenhum pixel opaco encosta nas bordas de cima, esquerda e direita. */
  private clearEdges(data: Buffer, width: number, height: number): void {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const onEdge = y < EDGE_CLEAR_PX || x < EDGE_CLEAR_PX || x >= width - EDGE_CLEAR_PX;
        if (onEdge) data[(y * width + x) * 4 + 3] = 0;
      }
    }
  }

  private async decideKey(raw: RawImage): Promise<McCutoutKeyDecision> {
    const sample = await sharp(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    })
      .resize(KEY_SAMPLE_SIZE, KEY_SAMPLE_SIZE, { fit: 'inside' })
      .raw()
      .toBuffer();
    return chooseCutoutKey({ data: sample, channels: 4 });
  }

  private identityMissing(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'KIT_IDENTITY_FILE_MISSING',
      message: 'A imagem da identidade do kit não foi encontrada no servidor.',
    });
  }
}
