import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Font } from './entities/font.entity';
import { CreateFontDto } from './dto/create-font.dto';
import { isValidFontFile } from '../../common/utils/file.util';

@Injectable()
export class FontsService {
  constructor(
    @InjectRepository(Font)
    private fontRepository: Repository<Font>,
  ) {}

  async create(createFontDto: CreateFontDto, fileUrl: string): Promise<Font> {
    const font = this.fontRepository.create({
      ...createFontDto,
      fileUrl,
    });

    return this.fontRepository.save(font);
  }

  async findAll(): Promise<Font[]> {
    return this.fontRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Font> {
    const font = await this.fontRepository.findOne({
      where: { id },
    });

    if (!font) {
      throw new NotFoundException({
        code: 'FONT_NOT_FOUND',
        message: 'Fonte não encontrada',
      });
    }

    return font;
  }

  async remove(id: string): Promise<void> {
    const font = await this.findOne(id);
    await this.fontRepository.remove(font);
  }

  validateFontFile(filename: string): void {
    if (!isValidFontFile(filename)) {
      throw new BadRequestException({
        code: 'INVALID_FONT_FILE',
        message: 'Arquivo deve ser .ttf, .otf, .woff ou .woff2',
      });
    }
  }
}
