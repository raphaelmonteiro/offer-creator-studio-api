import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { CommercialsService } from '../commercials.service';
import { McProjectLogoBox } from '../domain/mc-logo-face';
import {
  MC_PIECE_DEFAULT_DURATION_S,
  McPieceDocument,
  pieceBlock,
  pieceSpokenOffers,
} from '../domain/mc-piece';
import { assertFormatEnabled, assertPipelineV2ForFormat } from '../domain/mc-pipeline.config';
import { MC_DEFAULT_PROJECT_TIER, McSealProduct } from '../domain/mc-types';
import { CreateProjectDto } from '../dto/create-project.dto';
import { CreateProjectFromPieceDto } from '../dto/piece.dto';
import { McProject } from '../entities/mc-project.entity';
import { McPiecesService } from './mc-pieces.service';

/**
 * Ponte peça → projeto (change video-peca-configuravel, tarefa 5.1): a peça
 * validada e do usuário vira um projeto `offer_piece` em `scripting`, com a
 * cópia imutável do descritor (`pieceSnapshot`), as ofertas FALADAS como
 * `products` e, no modo rosto do logo, a caixa do logo já confirmada (o bloco
 * da logo é a caixa — sem detecção). As gates de criação (pausa, formato, v2,
 * preflight, kit aprovado e com tile) ficam em `createProject`.
 */
@Injectable()
export class McFromPieceService {
  constructor(
    private readonly pieces: McPiecesService,
    private readonly commercials: CommercialsService,
  ) {}

  async createFromPiece(userId: string, dto: CreateProjectFromPieceDto): Promise<McProject> {
    assertFormatEnabled('offer_piece');
    assertPipelineV2ForFormat('offer_piece');

    const piece = await this.pieces.findOwned(userId, dto.pieceId);
    if (piece.kind !== 'piece') {
      throw new UnprocessableEntityException({
        code: 'PIECE_IS_TEMPLATE',
        message: 'Um modelo não vira vídeo: crie uma peça a partir dele e escolha os produtos.',
      });
    }
    const issues = await this.pieces.issuesFor(userId, piece.document);
    if (issues.length > 0) {
      throw new UnprocessableEntityException({
        code: 'PIECE_INVALID',
        message: 'A peça ainda não está pronta para gerar o vídeo.',
        issues,
      });
    }
    const character = pieceBlock(piece.document, 'character');
    if (!character) {
      // `issuesFor` já cobre; defesa em profundidade para o tipo.
      throw new UnprocessableEntityException({
        code: 'PIECE_INVALID',
        message: 'A peça precisa de um personagem.',
        issues: [{ code: 'CHARACTER_MISSING', message: 'A peça precisa de um personagem.' }],
      });
    }
    const offers = pieceSpokenOffers(piece.document);
    const createDto: CreateProjectDto = {
      kitId: character.kitId,
      title: (dto.title?.trim() || piece.name).slice(0, 120),
      briefing: McFromPieceService.defaultBriefing(piece.name, offers),
      aspectRatio: piece.aspectRatio,
      targetDurationS: MC_PIECE_DEFAULT_DURATION_S,
      products: offers.map((o) => ({
        name: o.name,
        price: o.price,
        unit: o.unit ?? null,
        imageUrl: o.imageUrl ?? null,
      })),
      format: 'offer_piece',
      tier: dto.tier ?? MC_DEFAULT_PROJECT_TIER,
      channel: dto.channel,
      captionsEnabled: dto.captionsEnabled ?? false,
      musicEnabled: dto.musicEnabled ?? false,
    };
    return this.commercials.createProject(userId, createDto, {
      pieceId: piece.id,
      pieceSnapshot: piece.document,
      logoBox: McFromPieceService.logoBoxFor(piece.document),
    });
  }

  /** Rosto do logo: o rect do bloco do personagem é a caixa, confirmada por construção. */
  static logoBoxFor(document: McPieceDocument): McProjectLogoBox | null {
    const character = pieceBlock(document, 'character');
    if (!character || character.mode !== 'logo_face') return null;
    return {
      x: character.rect.x,
      y: character.rect.y,
      w: character.rect.w,
      h: character.rect.h,
      logoBoxSource: 'layout',
      logoBoxConfidence: null,
      logoBoxConfirmed: true,
      surroundColor: character.panel?.color ?? null,
    };
  }

  /** O DTO exige 10+ caracteres; o diretor da peça lê as ofertas do snapshot, não daqui. */
  static defaultBriefing(name: string, offers: McSealProduct[]): string {
    const list = offers
      .map((o) => `${o.name} por R$ ${o.price}${o.unit ? ` (${o.unit})` : ''}`)
      .join('; ');
    return `Peça "${name}" com as ofertas: ${list || 'conferir na peça'}.`.slice(0, 2000);
  }
}
