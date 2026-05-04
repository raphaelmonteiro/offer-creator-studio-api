import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { FlyerBuilderV2Document } from './entities/flyer-builder-v2-document.entity';
import { CreateFlyerBuilderV2DocumentDto } from './dto/create-flyer-builder-v2-document.dto';
import { UpdateFlyerBuilderV2DocumentDto } from './dto/update-flyer-builder-v2-document.dto';
import { QueryFlyerBuilderV2DocumentDto } from './dto/query-flyer-builder-v2-document.dto';
import { paginate, PaginationResult } from '../../common/utils/pagination.util';

const BUILDER_ID = 'flyer-builder-v2';
const SCHEMA_VERSION = 2;
const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;

@Injectable()
export class FlyerBuilderV2Service {
  constructor(
    @InjectRepository(FlyerBuilderV2Document)
    private readonly documentRepository: Repository<FlyerBuilderV2Document>,
  ) {}

  async create(dto: CreateFlyerBuilderV2DocumentDto): Promise<FlyerBuilderV2Document> {
    this.validateDocument(dto.document);

    try {
      const document = this.documentRepository.create({
        name: dto.name,
        clientId: dto.clientId || null,
        status: dto.status || 'draft',
        schemaVersion: SCHEMA_VERSION,
        builder: BUILDER_ID,
        document: dto.document,
      });

      return await this.documentRepository.save(document);
    } catch (error) {
      this.handlePersistenceError(error, 'FLYER_BUILDER_V2_CREATION_ERROR', 'Erro ao criar documento V2');
    }
  }

  async findAll(
    query: QueryFlyerBuilderV2DocumentDto,
  ): Promise<PaginationResult<FlyerBuilderV2Document>> {
    const { page = 1, limit = 20, search, clientId } = query;
    const skip = (page - 1) * limit;

    const queryBuilder = this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect('document.client', 'client');

    if (search) {
      queryBuilder.where({ name: Like(`%${search}%`) });
    }

    if (clientId) {
      queryBuilder.andWhere('document.clientId = :clientId', { clientId });
    }

    queryBuilder.skip(skip).take(limit).orderBy('document.createdAt', 'DESC');

    const [documents, total] = await queryBuilder.getManyAndCount();
    const transformed = documents.map((document) => ({
      ...document,
      clientName: document.client?.name || null,
    }));

    return paginate(transformed, total, { page, limit });
  }

  async findOne(id: string): Promise<any> {
    const document = await this.documentRepository.findOne({
      where: { id },
      relations: ['client'],
    });

    if (!document) {
      throw new NotFoundException({
        code: 'FLYER_BUILDER_V2_DOCUMENT_NOT_FOUND',
        message: 'Documento V2 não encontrado',
      });
    }

    return {
      ...document,
      clientName: document.client?.name || null,
    };
  }

  async update(id: string, dto: UpdateFlyerBuilderV2DocumentDto): Promise<FlyerBuilderV2Document> {
    const existing = await this.documentRepository.findOne({ where: { id } });

    if (!existing) {
      throw new NotFoundException({
        code: 'FLYER_BUILDER_V2_DOCUMENT_NOT_FOUND',
        message: 'Documento V2 não encontrado',
      });
    }

    if (dto.document) {
      this.validateDocument(dto.document);
    }

    try {
      Object.assign(existing, {
        ...dto,
        clientId: dto.clientId === undefined ? existing.clientId : dto.clientId,
        schemaVersion: SCHEMA_VERSION,
        builder: BUILDER_ID,
      });

      return await this.documentRepository.save(existing);
    } catch (error) {
      this.handlePersistenceError(error, 'FLYER_BUILDER_V2_UPDATE_ERROR', 'Erro ao atualizar documento V2');
    }
  }

  async remove(id: string): Promise<void> {
    const document = await this.documentRepository.findOne({ where: { id } });

    if (!document) {
      throw new NotFoundException({
        code: 'FLYER_BUILDER_V2_DOCUMENT_NOT_FOUND',
        message: 'Documento V2 não encontrado',
      });
    }

    await this.documentRepository.remove(document);
  }

  private validateDocument(document: any): void {
    if (!document || typeof document !== 'object') {
      throw new BadRequestException({
        code: 'INVALID_FLYER_BUILDER_V2_DOCUMENT',
        message: 'Documento V2 inválido',
      });
    }

    if (document.builder !== BUILDER_ID || document.schemaVersion !== SCHEMA_VERSION) {
      throw new BadRequestException({
        code: 'INVALID_FLYER_BUILDER_V2_SCHEMA',
        message: 'Schema do documento V2 inválido',
      });
    }

    const documentSize = JSON.stringify(document).length;
    if (documentSize > MAX_DOCUMENT_SIZE) {
      throw new BadRequestException({
        code: 'DOCUMENT_TOO_LARGE',
        message: `O documento V2 é muito grande (${(documentSize / 1024 / 1024).toFixed(2)}MB). Use URLs de imagens em vez de base64.`,
      });
    }
  }

  private handlePersistenceError(error: unknown, code: string, message: string): never {
    if (error instanceof BadRequestException || error instanceof NotFoundException) {
      throw error;
    }

    throw new InternalServerErrorException({
      code,
      message,
      details: process.env.NODE_ENV !== 'production' && error instanceof Error ? error.message : undefined,
    });
  }
}

