import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McStorageService } from './mc-storage.service';

/** Mesmo teto do multer (`createFileInterceptor`): 50 MB. */
export const MC_PIECE_BACKGROUND_MAX_BYTES = 50 * 1024 * 1024;
export const MC_PIECE_BACKGROUND_ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
const ACCEPTED_LABEL = 'PNG, JPEG ou WebP';

/** Resposta de `POST /commercials/pieces/backgrounds`. */
export interface McPieceBackgroundView {
  assetId: string;
  /** URL em /uploads/… — vai para `document.background.imageUrl`. */
  url: string;
  width: number;
  height: number;
  mimeType: string;
}

/**
 * Fundo enviado para uma peça de ofertas (change video-peca-configuravel,
 * tarefas 6.6/7.3): grava em `/uploads/commercials/pieces/{userId}/` via
 * McStorageService (escrita atômica), lê largura/altura com `sharp` e registra
 * o `AnimationAsset` `{kind: 'piece_background', origin: 'imported'}` — o GC
 * só o recolhe quando nenhum `mc_pieces.document`/`pieceSnapshot` aponta para
 * a URL (30 dias). Modelado em `McArtService.upload`.
 */
@Injectable()
export class McPieceBackgroundService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: McStorageService,
  ) {}

  relDir(userId: string): string {
    return `commercials/pieces/${userId}`;
  }

  async upload(
    userId: string,
    file: Express.Multer.File | undefined,
  ): Promise<McPieceBackgroundView> {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: `Envie a imagem de fundo (${ACCEPTED_LABEL}) no campo "file".`,
        details: { accepted: [...MC_PIECE_BACKGROUND_ACCEPTED_MIME] },
      });
    }
    if (file.buffer.length > MC_PIECE_BACKGROUND_MAX_BYTES) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: 'A imagem excede o limite de 50 MB.',
        details: { maxBytes: MC_PIECE_BACKGROUND_MAX_BYTES },
      });
    }
    let meta: sharp.Metadata;
    try {
      meta = await sharp(file.buffer).metadata();
    } catch {
      throw new BadRequestException({
        code: 'INVALID_IMAGE_FILE',
        message: `Não foi possível ler o arquivo como imagem. Envie o fundo em ${ACCEPTED_LABEL}.`,
        details: {
          accepted: [...MC_PIECE_BACKGROUND_ACCEPTED_MIME],
          received: file.mimetype || null,
        },
      });
    }
    const format = meta.format === 'jpg' ? 'jpeg' : meta.format;
    if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
      throw new BadRequestException({
        code: 'INVALID_IMAGE_FILE',
        message: `O arquivo é ${meta.format ?? 'de formato desconhecido'}; envie o fundo em ${ACCEPTED_LABEL}.`,
        details: {
          accepted: [...MC_PIECE_BACKGROUND_ACCEPTED_MIME],
          received: meta.format ?? null,
        },
      });
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw new BadRequestException({
        code: 'INVALID_IMAGE_FILE',
        message: 'A imagem não tem dimensões legíveis.',
      });
    }
    const mimeType = `image/${format}`;
    const contentHash = createHash('sha256').update(file.buffer).digest('hex');
    const ext = format === 'jpeg' ? 'jpg' : format;
    const name = `bg-${Date.now()}-${contentHash.slice(0, 12)}.${ext}`;
    const url = await this.storage.saveFile(this.relDir(userId), name, file.buffer);
    const asset = await this.dataSource.getRepository(AnimationAsset).save({
      userId,
      kind: 'piece_background' as const,
      status: 'ready' as const,
      name: (file.originalname || name).slice(0, 200),
      origin: 'imported' as const,
      fileUrl: url,
      mimeType,
      width,
      height,
      fileSize: String(file.buffer.length),
      hasAlpha: Boolean(meta.hasAlpha),
      contentHash,
      metadata: { originalFilename: file.originalname ?? null, sourceMimeType: file.mimetype },
    });
    return { assetId: asset.id, url, width, height, mimeType };
  }
}
