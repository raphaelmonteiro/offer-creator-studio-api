import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Not } from 'typeorm';
import { McCutoutKeyColor, McCutoutKeyDecision } from '../domain/mc-cutout-key';
import { isCharacterCutoutEnabled } from '../domain/mc-cutout.config';
import { McPieceDocument, pieceBlock } from '../domain/mc-piece';
import {
  characterFieldViolations,
  characterUsesCutout,
  McPieceFraming,
  resolveCharacterFraming,
} from '../domain/mc-piece-character';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McKitBodyTileService } from './mc-kit-body-tile.service';

/** O que o modo do personagem resolve para o roteiro (D9). */
export interface McCutoutResolution {
  cutout: boolean;
  framing: McPieceFraming;
  /** Cor-chave escolhida para o kit; null fora do modo sem fundo. */
  keyColor: McCutoutKeyColor | null;
}

export interface McCutoutRequest {
  userId: string;
  kitId: string;
  cutout: boolean;
  framing: McPieceFraming;
  logoFace: boolean;
}

/**
 * Checagens do recorte do personagem antes de qualquer gasto (video-mascote-transparente,
 * D2/D3/D8): forma (400), flag (422 CHARACTER_CUTOUT_DISABLED), rosto do logo (422
 * CHARACTER_CUTOUT_LOGO_FACE), tile de corpo calculado sob demanda (erros 422 do tile) e cor-chave
 * segura (422 CHARACTER_CUTOUT_KEY_UNSAFE). Nada é gravado em nenhuma recusa.
 */
@Injectable()
export class McCutoutGuardService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bodyTile: McKitBodyTileService,
  ) {}

  /** `panel.shape` ou `framing` fora da lista → 400 `PIECE_CHARACTER_FIELD_INVALID`. */
  assertFieldsValid(document: McPieceDocument): void {
    const [first] = characterFieldViolations(document);
    if (!first) return;
    throw new BadRequestException({
      code: 'PIECE_CHARACTER_FIELD_INVALID',
      message:
        first.field === 'panel.shape'
          ? 'O formato do painel do personagem precisa ser none, card ou circle.'
          : 'O enquadramento do personagem precisa ser busto ou corpo.',
      details: { blockId: first.blockId, field: first.field, allowed: first.allowed },
    });
  }

  /** Peça: campos (400) + recorte do bloco do personagem (422). Sem personagem = nada a checar. */
  async assertPiece(userId: string, document: McPieceDocument): Promise<McCutoutResolution> {
    this.assertFieldsValid(document);
    const character = pieceBlock(document, 'character');
    return this.resolve({
      userId,
      kitId: character?.kitId ?? '',
      cutout: characterUsesCutout(character),
      framing: resolveCharacterFraming(character),
      logoFace: character?.mode === 'logo_face',
    });
  }

  /** Núcleo compartilhado com a arte que fala (R6/R7). */
  async resolve(request: McCutoutRequest): Promise<McCutoutResolution> {
    const { cutout, framing } = request;
    const resolution: McCutoutResolution = { cutout, framing, keyColor: null };
    if (!cutout && framing !== 'corpo') return resolution;
    if (!isCharacterCutoutEnabled()) {
      throw new UnprocessableEntityException({
        code: 'CHARACTER_CUTOUT_DISABLED',
        message: 'O personagem sem fundo e o enquadramento de corpo não estão habilitados.',
      });
    }
    if (request.logoFace) {
      throw new UnprocessableEntityException({
        code: 'CHARACTER_CUTOUT_LOGO_FACE',
        message:
          'O modo "rosto do logo" não aceita personagem sem fundo nem enquadramento de corpo.',
      });
    }
    const kit = request.kitId
      ? await this.dataSource.getRepository(McCharacterKit).findOne({
          where: { id: request.kitId, userId: request.userId, status: Not(McKitStatus.FAILED) },
        })
      : null;
    // kit inexistente segue como a issue CHARACTER_KIT_UNKNOWN de hoje (sem 422 de recorte)
    if (!kit) return resolution;
    const asset = await this.bodyTile.ensure(kit);
    if (!cutout) return resolution;
    const key = asset.metadata?.cutoutKey as McCutoutKeyDecision | undefined;
    if (!key?.chosen) throw this.keyUnsafe(kit.id, key);
    return { ...resolution, keyColor: key.chosen };
  }

  private keyUnsafe(kitId: string, key: McCutoutKeyDecision | undefined): never {
    throw new UnprocessableEntityException({
      code: 'CHARACTER_CUTOUT_KEY_UNSAFE',
      message:
        'As cores desta personagem são parecidas demais com o verde e o azul de recorte; use um painel liso.',
      details: {
        kitId,
        candidates: (key?.candidates ?? []).map((c) => ({
          color: c.color,
          nearFraction40: c.near40,
          nearFraction60: c.near60,
        })),
        actions: ['use_flat_panel'],
      },
    });
  }
}
