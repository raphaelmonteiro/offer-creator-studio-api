import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, Not } from 'typeorm';
import { Client } from '../../clients/entities/client.entity';
import { Font } from '../../fonts/entities/font.entity';
import {
  applyClientToPiece,
  defaultPieceDocument,
  MC_PIECE_MAX_BYTES,
  MC_PIECE_STRUCTURAL_CODES,
  McPieceDocument,
  McPieceIssue,
  pieceBlock,
  pieceDocumentBytes,
  templateFromPiece,
  validatePieceDocument,
} from '../domain/mc-piece';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McPiece, McPieceKind } from '../entities/mc-piece.entity';
import { McProject } from '../entities/mc-project.entity';
import {
  CreatePieceDto,
  ListPiecesQueryDto,
  SaveAsTemplateDto,
  UpdatePieceDto,
} from '../dto/piece.dto';

/** Resposta de GET/PATCH /commercials/pieces/:id: a peça + o que falta para gerar. */
export interface McPieceView {
  id: string;
  userId: string;
  clientId: string | null;
  kind: McPieceKind;
  name: string;
  aspectRatio: McPiece['aspectRatio'];
  document: McPieceDocument;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  /** Problemas do descritor (bloco/item apontados). Vazio = pronta para gerar. */
  issues: McPieceIssue[];
}

/** Projeto que ainda pode precisar da peça (apagar a peça é recusado). */
const PROJECT_ACTIVE_STATUSES: McProjectStatus[] = [
  McProjectStatus.DRAFT,
  McProjectStatus.SCRIPTING,
  McProjectStatus.STORYBOARD_REVIEW,
  McProjectStatus.PREPARING,
  McProjectStatus.VISUAL_REVIEW,
  McProjectStatus.GENERATING,
  McProjectStatus.NEEDS_ATTENTION,
  McProjectStatus.ASSEMBLING,
];

/**
 * Peças de ofertas (change video-peca-configuravel, grupo 4): CRUD com
 * autosave por revisão, modelos da conta e a validação do descritor
 * (`domain/mc-piece`). Não cria projeto: isso é `POST projects/from-piece`
 * (grupo 5), que exige `issues` vazio.
 */
@Injectable()
export class McPiecesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async create(userId: string, dto: CreatePieceDto): Promise<McPieceView> {
    const client = await this.dataSource.getRepository(Client).findOneBy({ id: dto.clientId });
    if (!client) {
      throw new NotFoundException({ code: 'CLIENT_NOT_FOUND', message: 'Cliente não encontrado.' });
    }
    let document = defaultPieceDocument(dto.aspectRatio);
    if (dto.templateId) {
      const template = await this.findOwned(userId, dto.templateId);
      if (template.kind !== 'template') {
        throw new UnprocessableEntityException({
          code: 'PIECE_NOT_TEMPLATE',
          message: 'A peça escolhida como ponto de partida não é um modelo.',
        });
      }
      document = { ...template.document, aspectRatio: dto.aspectRatio };
    }
    document = applyClientToPiece(document, {
      logoUrl: client.logoUrl,
      address: client.address,
      phone: client.phoneMobile ?? client.phoneFixed,
    });
    const saved = await this.dataSource.getRepository(McPiece).save({
      userId,
      clientId: client.id,
      kind: 'piece' as const,
      name: dto.name?.trim() || `Ofertas de ${client.name}`,
      aspectRatio: dto.aspectRatio,
      document,
      revision: 0,
    });
    return this.toView(userId, saved);
  }

  async findAll(userId: string, query: ListPiecesQueryDto): Promise<Omit<McPieceView, 'issues'>[]> {
    const rows = await this.dataSource.getRepository(McPiece).find({
      where: {
        userId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.clientId ? { clientId: query.clientId } : {}),
      },
      order: { updatedAt: 'DESC' },
    });
    return rows.map((row) => ({ ...row }));
  }

  async findOne(userId: string, id: string): Promise<McPieceView> {
    return this.toView(userId, await this.findOwned(userId, id));
  }

  /**
   * Autosave: o documento inteiro com a revisão que o editor tem. Forma
   * estrutural inválida → 422 PIECE_INVALID; regras de negócio abertas não
   * bloqueiam (voltam em `issues`). Revisão diferente → 409 com a atual.
   */
  async update(userId: string, id: string, dto: UpdatePieceDto): Promise<McPieceView> {
    const piece = await this.findOwned(userId, id);
    const document = dto.document;
    if (pieceDocumentBytes(document) > MC_PIECE_MAX_BYTES) {
      throw new UnprocessableEntityException({
        code: 'PIECE_TOO_LARGE',
        message: `O descritor da peça passa de ${Math.round(MC_PIECE_MAX_BYTES / 1024 / 1024)} MB.`,
      });
    }
    const structural = validatePieceDocument(document).filter((issue) =>
      MC_PIECE_STRUCTURAL_CODES.includes(issue.code),
    );
    if (structural.length > 0) {
      throw new UnprocessableEntityException({
        code: 'PIECE_INVALID',
        message: 'O descritor da peça tem blocos inválidos.',
        issues: structural,
      });
    }
    const repo = this.dataSource.getRepository(McPiece);
    const result = await repo.update(
      { id: piece.id, revision: dto.expectedRevision },
      {
        document,
        aspectRatio: document.aspectRatio,
        ...(dto.name?.trim() ? { name: dto.name.trim() } : {}),
        revision: dto.expectedRevision + 1,
      },
    );
    if (!result.affected) {
      const current = await repo.findOneBy({ id: piece.id });
      throw new ConflictException({
        code: 'REVISION_CONFLICT',
        message: 'A peça foi alterada em outra aba. Recarregue antes de continuar.',
        revision: current?.revision ?? piece.revision,
      });
    }
    const fresh = await repo.findOneByOrFail({ id: piece.id });
    return this.toView(userId, fresh);
  }

  /** Modelo da conta a partir da peça: visual sem produtos, logo e dados do cliente. */
  async saveAsTemplate(userId: string, id: string, dto: SaveAsTemplateDto): Promise<McPieceView> {
    const piece = await this.findOwned(userId, id);
    const saved = await this.dataSource.getRepository(McPiece).save({
      userId,
      clientId: null,
      kind: 'template' as const,
      name: dto.name.trim(),
      aspectRatio: piece.aspectRatio,
      document: templateFromPiece(piece.document),
      revision: 0,
    });
    return this.toView(userId, saved);
  }

  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    const piece = await this.findOwned(userId, id);
    const inUse = await this.dataSource.getRepository(McProject).count({
      where: { pieceId: piece.id, status: In(PROJECT_ACTIVE_STATUSES) },
    });
    if (inUse > 0) {
      throw new UnprocessableEntityException({
        code: 'PIECE_IN_USE',
        message:
          'Esta peça tem um vídeo em andamento. Termine ou cancele o vídeo antes de apagá-la.',
        details: { projects: inUse },
      });
    }
    await this.dataSource.getRepository(McPiece).delete({ id: piece.id });
    return { deleted: true };
  }

  async findOwned(userId: string, id: string): Promise<McPiece> {
    const piece = await this.dataSource.getRepository(McPiece).findOneBy({ id });
    if (!piece) {
      throw new NotFoundException({ code: 'PIECE_NOT_FOUND', message: 'Peça não encontrada.' });
    }
    if (piece.userId !== userId) throw new ForbiddenException();
    return piece;
  }

  /**
   * Issues do descritor com o contexto que só o banco sabe: fontes da conta
   * e o modo de identidade do kit do personagem (kit inexistente ou de outro
   * dono vira `CHARACTER_KIT_UNKNOWN`).
   */
  async issuesFor(userId: string, document: McPieceDocument): Promise<McPieceIssue[]> {
    const fonts = await this.dataSource.getRepository(Font).find({ select: ['family'] });
    const fontFamilies = Array.from(new Set(fonts.map((f) => f.family)));
    const character = pieceBlock(document, 'character');
    let kitIdentityMode: McCharacterKit['identityMode'] | null = null;
    const issues: McPieceIssue[] = [];
    if (character?.kitId) {
      const kit = await this.dataSource.getRepository(McCharacterKit).findOne({
        where: { id: character.kitId, userId, status: Not(McKitStatus.FAILED) },
      });
      if (!kit) {
        issues.push({
          code: 'CHARACTER_KIT_UNKNOWN',
          blockId: character.id,
          message: 'O kit do personagem não existe ou não é seu.',
        });
      } else {
        kitIdentityMode = kit.identityMode;
      }
    }
    return [...validatePieceDocument(document, { kitIdentityMode, fontFamilies }), ...issues];
  }

  private async toView(userId: string, piece: McPiece): Promise<McPieceView> {
    return { ...piece, issues: await this.issuesFor(userId, piece.document) };
  }
}
