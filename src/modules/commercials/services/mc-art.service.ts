import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { MediaAssetsService } from '../../../shared/media-assets/media-assets.service';
import { inferAspectRatio } from '../domain/mc-composition.config';
import { McAspectRatio } from '../domain/mc-types';
import { McStorageService } from './mc-storage.service';

/** Mesmo teto do multer (`createFileInterceptor`): 50 MB. */
export const MC_ART_MAX_BYTES = 50 * 1024 * 1024;

/** Tipos aceitos (design D9): a arte é rasterizada no cliente como PNG; JPEG para artes já exportadas. */
export const MC_ART_ACCEPTED_MIME = ['image/png', 'image/jpeg'] as const;
const ACCEPTED_LABEL = 'PNG ou JPEG';

/** Resposta de POST /commercials/art e GET /commercials/art/:id. */
export interface McArtView {
  assetId: string;
  width: number;
  height: number;
  aspectRatio: McAspectRatio;
  url: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

/**
 * Envio da arte (tarefa 5.1, design D9), modelado em `POST /mascots`: grava
 * em `/uploads/commercials/art/{userId}/` via McStorageService (escrita
 * atômica), lê largura/altura com `sharp`, infere o aspecto pela regra D12 e
 * registra o `AnimationAsset` `{kind: 'video_art', origin: 'imported',
 * status: 'ready'}` que a ponte (`POST /commercials/projects/from-art`)
 * valida com `MediaAssetsService.findOwned`.
 *
 * Rejeitado `POST /uploads`: devolve só o nome do arquivo numa pasta fixa,
 * sem asset, e limita em 5 MB.
 */
@Injectable()
export class McArtService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: McStorageService,
    private readonly mediaAssets: MediaAssetsService,
  ) {}

  artRelDir(userId: string): string {
    return `commercials/art/${userId}`;
  }

  async upload(userId: string, file: Express.Multer.File | undefined): Promise<McArtView> {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: `Envie a arte como imagem (${ACCEPTED_LABEL}) no campo "file".`,
        details: { accepted: [...MC_ART_ACCEPTED_MIME] },
      });
    }
    if (file.size > MC_ART_MAX_BYTES || file.buffer.length > MC_ART_MAX_BYTES) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: 'A arte excede o limite de 50 MB.',
        details: { maxBytes: MC_ART_MAX_BYTES },
      });
    }
    if (!(MC_ART_ACCEPTED_MIME as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestException({
        code: 'INVALID_ART_FILE',
        message: `Formato não suportado (${file.mimetype || 'desconhecido'}). Envie a arte em ${ACCEPTED_LABEL}.`,
        details: { accepted: [...MC_ART_ACCEPTED_MIME], received: file.mimetype || null },
      });
    }

    // O conteúdo manda, não o cabeçalho: um PDF renomeado para .png chega
    // com mimetype de imagem e cai aqui (sharp não lê PDF).
    let meta: sharp.Metadata;
    try {
      meta = await sharp(file.buffer).metadata();
    } catch {
      throw new BadRequestException({
        code: 'INVALID_ART_FILE',
        message: `Não foi possível ler o arquivo como imagem. Envie a arte em ${ACCEPTED_LABEL}.`,
        details: { accepted: [...MC_ART_ACCEPTED_MIME], received: file.mimetype || null },
      });
    }
    const format = meta.format === 'jpg' ? 'jpeg' : meta.format;
    if (format !== 'png' && format !== 'jpeg') {
      throw new BadRequestException({
        code: 'INVALID_ART_FILE',
        message: `O arquivo é ${meta.format ?? 'de formato desconhecido'}; envie a arte em ${ACCEPTED_LABEL}.`,
        details: { accepted: [...MC_ART_ACCEPTED_MIME], received: meta.format ?? null },
      });
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw new BadRequestException({
        code: 'INVALID_ART_FILE',
        message: 'A imagem não tem dimensões legíveis.',
      });
    }

    const mimeType = `image/${format}`;
    const aspectRatio = inferAspectRatio(width, height);
    const contentHash = createHash('sha256').update(file.buffer).digest('hex');
    const name = `art-${Date.now()}-${contentHash.slice(0, 12)}.${format === 'jpeg' ? 'jpg' : 'png'}`;
    const fileUrl = await this.storage.saveFile(this.artRelDir(userId), name, file.buffer);

    const asset = await this.dataSource.getRepository(AnimationAsset).save({
      userId,
      kind: 'video_art' as const,
      status: 'ready' as const,
      name: (file.originalname || name).slice(0, 200),
      origin: 'imported' as const,
      fileUrl,
      mimeType,
      width,
      height,
      fileSize: String(file.buffer.length),
      hasAlpha: Boolean(meta.hasAlpha),
      contentHash,
      metadata: {
        aspectRatio,
        originalFilename: file.originalname ?? null,
        sourceMimeType: file.mimetype,
      },
    });
    return McArtService.toView(asset as AnimationAsset);
  }

  /** Asset da arte do usuário (404/403 pelo MediaAssetsService; kind errado também é 404). */
  async findOwned(userId: string, assetId: string): Promise<AnimationAsset> {
    const asset = await this.mediaAssets.findOwned(userId, assetId);
    if (asset.kind !== 'video_art') {
      throw new NotFoundException({
        code: 'ART_NOT_FOUND',
        message: 'O asset informado não é uma arte enviada por POST /commercials/art.',
      });
    }
    return asset;
  }

  async findOne(userId: string, assetId: string): Promise<McArtView> {
    return McArtService.toView(await this.findOwned(userId, assetId));
  }

  /** Aspecto gravado no envio; recalculado das dimensões quando o metadata não o tem. */
  static aspectRatioOf(asset: AnimationAsset): McAspectRatio {
    const stored = asset.metadata?.aspectRatio;
    if (typeof stored === 'string' && stored.length > 0) return stored as McAspectRatio;
    return inferAspectRatio(asset.width ?? 0, asset.height ?? 0);
  }

  static toView(asset: AnimationAsset): McArtView {
    return {
      assetId: asset.id,
      width: asset.width ?? 0,
      height: asset.height ?? 0,
      aspectRatio: McArtService.aspectRatioOf(asset),
      url: asset.fileUrl ?? null,
      mimeType: asset.mimeType ?? null,
      fileSize: asset.fileSize != null ? Number(asset.fileSize) : null,
    };
  }
}
