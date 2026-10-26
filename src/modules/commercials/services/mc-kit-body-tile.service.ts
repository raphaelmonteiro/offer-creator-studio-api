import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McBodyTilePlan, planBodyTile } from '../domain/mc-body-tile';
import { McNormalizedBox } from '../domain/mc-mouth-gate';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import {
  assertBorder,
  decideKey,
  keyBackground,
  RawImage,
  readRaw,
  renderTile,
} from './mc-body-tile-image';
import { McStorageService } from './mc-storage.service';

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
    const reusable = await this.reusableBodyTile(kit, tile, identityId);
    if (reusable) return reusable;
    if (kit.identityMode === 'logo_as_is') return this.useLogoAsBody(kit, tile);
    const identity = identityId ? await assets.findOneBy({ id: identityId }) : null;
    return this.buildBody(kit, tile, identity);
  }

  /** Logo como está: o "corpo" é o próprio tile; só a chave é calculada (aviso LOGO_AS_IS_NO_BODY). */
  private async useLogoAsBody(kit: McCharacterKit, tile: AnimationAsset): Promise<AnimationAsset> {
    const source = tile.fileUrl ? await this.storage.readUploadsFile(tile.fileUrl) : null;
    if (!source) throw this.identityMissing();
    const raw = await readRaw(source);
    const cutoutKey = await decideKey(raw);
    const repo = this.dataSource.getRepository(AnimationAsset);
    tile.metadata = { ...tile.metadata, cutoutKey };
    await repo.update({ id: tile.id }, { metadata: tile.metadata });
    return this.claim(kit, tile);
  }

  /** Tile de corpo já gravado no kit, da mesma identidade e com a chave decidida; senão null. */
  private async reusableBodyTile(
    kit: McCharacterKit,
    tile: AnimationAsset,
    identityId: string,
  ): Promise<AnimationAsset | null> {
    if (!kit.bodyTileAssetId) return null;
    const existing = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: kit.bodyTileAssetId });
    const sameIdentity =
      existing && (existing.id === tile.id || existing.metadata?.identityAssetId === identityId);
    return sameIdentity && existing.metadata?.cutoutKey ? existing : null;
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
    const raw = await readRaw(source);
    const uniformity = await assertBorder(raw);
    keyBackground(raw, uniformity);
    const plan = this.planFromRaw(raw, bbox);
    const png = await renderTile(raw, plan);
    const cutoutKey = await decideKey(raw);
    const created = await this.saveBodyAsset({
      kit,
      identity,
      plan,
      png,
      metadata: { bbox, detectedBackgroundColor: uniformity.hex, cutoutKey },
    });
    this.logger.log(
      `Kit ${kit.id}: tile de corpo ${plan.output.width}x${plan.output.height} (rosto ${Math.round(
        plan.faceFraction * 100,
      )}%, chave ${cutoutKey.chosen ?? 'nenhuma segura'})`,
    );
    return this.claim(kit, created);
  }

  /** Plano do tile a partir do alfa já chaveado; 422 com saída "busto" se não achar a figura. */
  private planFromRaw(raw: RawImage, bbox: McNormalizedBox): McBodyTilePlan {
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
    return result.plan;
  }

  /** Grava o arquivo do tile e o asset `kit_tile` (com a metadata do plano) no banco. */
  private async saveBodyAsset(input: {
    kit: McCharacterKit;
    identity: AnimationAsset;
    plan: McBodyTilePlan;
    png: Buffer;
    metadata: Record<string, unknown>;
  }): Promise<AnimationAsset> {
    const { kit, identity, plan, png, metadata } = input;
    const url = await this.storage.saveFile(
      `commercials/kits/${kit.id}`,
      `tile-corpo-${Date.now()}.png`,
      png,
    );
    return this.dataSource.getRepository(AnimationAsset).save({
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
        figure: plan.figure,
        margin: plan.margin,
        cutAtBottom: plan.cutAtBottom,
        faceFraction: plan.faceFraction,
        ratio: Number(plan.ratio.toFixed(4)),
        warnings: plan.warnings,
        ...metadata,
      },
    });
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

  private identityMissing(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'KIT_IDENTITY_FILE_MISSING',
      message: 'A imagem da identidade do kit não foi encontrada no servidor.',
    });
  }
}
