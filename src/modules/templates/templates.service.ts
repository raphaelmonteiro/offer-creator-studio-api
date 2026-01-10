import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Template } from './entities/template.entity';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { QueryTemplateDto } from './dto/query-template.dto';
import { paginate, PaginationResult } from '../../common/utils/pagination.util';

@Injectable()
export class TemplatesService {
  constructor(
    @InjectRepository(Template)
    private templateRepository: Repository<Template>,
  ) {}

  async create(createTemplateDto: CreateTemplateDto): Promise<Template> {
    try {
      // Validate configuration size
      const configSize = JSON.stringify(createTemplateDto.configuration).length;
      const maxSize = 10 * 1024 * 1024; // 10MB
      
      if (configSize > maxSize) {
        throw new BadRequestException({
          code: 'CONFIGURATION_TOO_LARGE',
          message: `A configuração é muito grande (${(configSize / 1024 / 1024).toFixed(2)}MB). Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.`,
        });
      }

      const template = this.templateRepository.create(createTemplateDto);
      return await this.templateRepository.save(template);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      // Handle database errors
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        
        if (errorMessage.includes('value too long') || errorMessage.includes('exceeds maximum')) {
          throw new BadRequestException({
            code: 'PAYLOAD_TOO_LARGE',
            message: 'O payload é muito grande. Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.',
            details: process.env.NODE_ENV !== 'production' ? error.message : undefined,
          });
        }
        
        if (errorMessage.includes('invalid input syntax') || errorMessage.includes('json')) {
          throw new BadRequestException({
            code: 'INVALID_JSON',
            message: 'Erro ao processar JSON na configuração. Verifique o formato dos dados.',
            details: process.env.NODE_ENV !== 'production' ? error.message : undefined,
          });
        }
      }
      
      // Re-throw as internal server error with more context
      throw new InternalServerErrorException({
        code: 'TEMPLATE_CREATION_ERROR',
        message: 'Erro ao criar template',
        details: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.message : String(error)) : undefined,
      });
    }
  }

  async findAll(query: QueryTemplateDto): Promise<PaginationResult<Template>> {
    const { page = 1, limit = 20, search, type, isDefault } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.name = Like(`%${search}%`);
    }

    if (type) {
      where.type = type;
    }

    if (isDefault !== undefined) {
      where.isDefault = isDefault;
    }

    const queryBuilder = this.templateRepository.createQueryBuilder('template');

    if (search) {
      queryBuilder.where('template.name LIKE :search', { search: `%${search}%` });
    }

    if (type) {
      queryBuilder.andWhere('template.type = :type', { type });
    }

    if (isDefault !== undefined) {
      queryBuilder.andWhere('template.isDefault = :isDefault', { isDefault });
    }

    queryBuilder.skip(skip).take(limit).orderBy('template.createdAt', 'DESC');

    const [templates, total] = await queryBuilder.getManyAndCount();

    return paginate(templates, total, { page, limit });
  }

  async findOne(id: string): Promise<Template> {
    const template = await this.templateRepository.findOne({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException({
        code: 'TEMPLATE_NOT_FOUND',
        message: 'Template não encontrado',
      });
    }

    return template;
  }

  async update(id: string, updateTemplateDto: UpdateTemplateDto): Promise<Template> {
    try {
      const template = await this.findOne(id);
      
      // Validate configuration size if being updated
      if (updateTemplateDto.configuration) {
        const configSize = JSON.stringify(updateTemplateDto.configuration).length;
        const maxSize = 10 * 1024 * 1024; // 10MB
        
        if (configSize > maxSize) {
          throw new BadRequestException({
            code: 'CONFIGURATION_TOO_LARGE',
            message: `A configuração é muito grande (${(configSize / 1024 / 1024).toFixed(2)}MB). Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.`,
          });
        }
      }
      
      Object.assign(template, updateTemplateDto);
      return await this.templateRepository.save(template);
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      
      // Handle database errors
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        
        if (errorMessage.includes('value too long') || errorMessage.includes('exceeds maximum')) {
          throw new BadRequestException({
            code: 'PAYLOAD_TOO_LARGE',
            message: 'O payload é muito grande. Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.',
            details: process.env.NODE_ENV !== 'production' ? error.message : undefined,
          });
        }
        
        if (errorMessage.includes('invalid input syntax') || errorMessage.includes('json')) {
          throw new BadRequestException({
            code: 'INVALID_JSON',
            message: 'Erro ao processar JSON na configuração. Verifique o formato dos dados.',
            details: process.env.NODE_ENV !== 'production' ? error.message : undefined,
          });
        }
      }
      
      throw new InternalServerErrorException({
        code: 'TEMPLATE_UPDATE_ERROR',
        message: 'Erro ao atualizar template',
        details: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.message : String(error)) : undefined,
      });
    }
  }

  async remove(id: string): Promise<void> {
    const template = await this.findOne(id);

    if (template.isDefault) {
      throw new BadRequestException({
        code: 'CANNOT_DELETE_DEFAULT',
        message: 'Não é possível remover templates padrão',
      });
    }

    await this.templateRepository.remove(template);
  }

  async updateThumbnail(id: string, thumbnailUrl: string): Promise<Template> {
    const template = await this.findOne(id);
    template.thumbnailUrl = thumbnailUrl;
    return this.templateRepository.save(template);
  }
}
