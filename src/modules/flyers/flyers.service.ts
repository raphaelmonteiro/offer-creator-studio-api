import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, Between } from 'typeorm';
import { Flyer } from './entities/flyer.entity';
import { CreateFlyerDto } from './dto/create-flyer.dto';
import { UpdateFlyerDto } from './dto/update-flyer.dto';
import { QueryFlyerDto } from './dto/query-flyer.dto';
import { DuplicateFlyerDto } from './dto/duplicate-flyer.dto';
import { paginate, PaginationResult } from '../../common/utils/pagination.util';

@Injectable()
export class FlyersService {
  constructor(
    @InjectRepository(Flyer)
    private flyerRepository: Repository<Flyer>,
  ) {}

  async create(createFlyerDto: CreateFlyerDto): Promise<Flyer> {
    try {
      // Validate configuration size
      const configSize = JSON.stringify(createFlyerDto.configuration).length;
      const maxSize = 10 * 1024 * 1024; // 10MB
      
      if (configSize > maxSize) {
        throw new BadRequestException({
          code: 'CONFIGURATION_TOO_LARGE',
          message: `A configuração é muito grande (${(configSize / 1024 / 1024).toFixed(2)}MB). Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.`,
        });
      }

      const flyer = this.flyerRepository.create({
        name: createFlyerDto.name,
        clientId: createFlyerDto.clientId || null,
        configuration: createFlyerDto.configuration,
        status: 'draft',
      });

      return await this.flyerRepository.save(flyer);
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
      
      // Re-throw as internal server error with more context
      throw new InternalServerErrorException({
        code: 'FLYER_CREATION_ERROR',
        message: 'Erro ao criar encarte',
        details: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.message : String(error)) : undefined,
      });
    }
  }

  async findAll(query: QueryFlyerDto): Promise<PaginationResult<Flyer>> {
    const { page = 1, limit = 20, search, clientId, startDate, endDate } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.name = Like(`%${search}%`);
    }

    if (clientId) {
      where.clientId = clientId;
    }

    if (startDate || endDate) {
      if (startDate && endDate) {
        where.createdAt = Between(new Date(startDate), new Date(endDate));
      } else if (startDate) {
        where.createdAt = Between(new Date(startDate), new Date());
      } else if (endDate) {
        where.createdAt = Between(new Date(0), new Date(endDate));
      }
    }

    const queryBuilder = this.flyerRepository.createQueryBuilder('flyer')
      .leftJoinAndSelect('flyer.client', 'client');

    if (search) {
      queryBuilder.where('flyer.name LIKE :search', { search: `%${search}%` });
    }

    if (clientId) {
      queryBuilder.andWhere('flyer.clientId = :clientId', { clientId });
    }

    if (startDate || endDate) {
      if (startDate && endDate) {
        queryBuilder.andWhere('flyer.createdAt BETWEEN :startDate AND :endDate', {
          startDate,
          endDate,
        });
      } else if (startDate) {
        queryBuilder.andWhere('flyer.createdAt >= :startDate', { startDate });
      } else if (endDate) {
        queryBuilder.andWhere('flyer.createdAt <= :endDate', { endDate });
      }
    }

    queryBuilder.skip(skip).take(limit).orderBy('flyer.createdAt', 'DESC');

    const [flyers, total] = await queryBuilder.getManyAndCount();

    // Transform to include clientName
    const transformedFlyers = flyers.map((flyer) => ({
      ...flyer,
      clientName: flyer.client?.name || null,
    }));

    return paginate(transformedFlyers, total, { page, limit });
  }

  async findOne(id: string): Promise<any> {
    const flyer = await this.flyerRepository.findOne({
      where: { id },
      relations: ['client'],
    });

    if (!flyer) {
      throw new NotFoundException({
        code: 'FLYER_NOT_FOUND',
        message: 'Encarte não encontrado',
      });
    }

    return {
      ...flyer,
      clientName: flyer.client?.name || null,
    };
  }

  async update(id: string, updateFlyerDto: UpdateFlyerDto): Promise<Flyer> {
    try {
      const flyer = await this.flyerRepository.findOne({
        where: { id },
      });

      if (!flyer) {
        throw new NotFoundException({
          code: 'FLYER_NOT_FOUND',
          message: 'Encarte não encontrado',
        });
      }

      // Validate configuration size if being updated
      if (updateFlyerDto.configuration) {
        const configSize = JSON.stringify(updateFlyerDto.configuration).length;
        const maxSize = 10 * 1024 * 1024; // 10MB
        
        if (configSize > maxSize) {
          throw new BadRequestException({
            code: 'CONFIGURATION_TOO_LARGE',
            message: `A configuração é muito grande (${(configSize / 1024 / 1024).toFixed(2)}MB). Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.`,
          });
        }
      }

      Object.assign(flyer, updateFlyerDto);
      return await this.flyerRepository.save(flyer);
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
        code: 'FLYER_UPDATE_ERROR',
        message: 'Erro ao atualizar encarte',
        details: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.message : String(error)) : undefined,
      });
    }
  }

  async remove(id: string): Promise<void> {
    const flyer = await this.flyerRepository.findOne({ where: { id } });
    if (!flyer) {
      throw new NotFoundException({
        code: 'FLYER_NOT_FOUND',
        message: 'Encarte não encontrado',
      });
    }
    await this.flyerRepository.remove(flyer);
  }

  async duplicate(id: string, duplicateDto: DuplicateFlyerDto): Promise<Flyer> {
    const originalFlyer = await this.flyerRepository.findOne({
      where: { id },
    });

    if (!originalFlyer) {
      throw new NotFoundException({
        code: 'FLYER_NOT_FOUND',
        message: 'Encarte não encontrado',
      });
    }

    const newFlyer = this.flyerRepository.create({
      name: duplicateDto.name,
      clientId: originalFlyer.clientId,
      configuration: originalFlyer.configuration,
      status: 'draft',
    });
    return this.flyerRepository.save(newFlyer);
  }

  async updateThumbnail(id: string, thumbnailUrl: string): Promise<Flyer> {
    const flyer = await this.flyerRepository.findOne({ where: { id } });
    if (!flyer) {
      throw new NotFoundException({
        code: 'FLYER_NOT_FOUND',
        message: 'Encarte não encontrado',
      });
    }
    flyer.thumbnailUrl = thumbnailUrl;
    return this.flyerRepository.save(flyer);
  }

  async export(id: string, format: string, quality: string): Promise<{ downloadUrl: string; expiresAt: Date }> {
    const flyer = await this.findOne(id);
    // TODO: Implement actual export logic (PDF, PNG, JPG generation)
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const downloadUrl = `${baseUrl}/exports/${id}_${Date.now()}.${format}`;
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // Expires in 24 hours

    return { downloadUrl, expiresAt };
  }
}
