import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { createFileInterceptor } from '../../common/utils/multer.util';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FontsService } from './fonts.service';
import { CreateFontDto } from './dto/create-font.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UploadsService } from '../uploads/uploads.service';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Fonts')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('fonts')
export class FontsController {
  constructor(
    private readonly fontsService: FontsService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post()
  @SkipValidation()
  @UseInterceptors(createFileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        family: {
          type: 'string',
          example: 'Bebas Neue',
        },
        weight: {
          type: 'string',
          example: '400',
        },
        style: {
          type: 'string',
          example: 'normal',
        },
      },
    },
  })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload de nova fonte' })
  @ApiResponse({ status: 201, description: 'Fonte criada com sucesso' })
  async create(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Arquivo é obrigatório',
      });
    }

    // Extract and validate form fields
    const { family, weight, style } = body;
    
    if (!family || !weight || !style) {
      throw new BadRequestException({
        code: 'MISSING_FIELDS',
        message: 'Campos obrigatórios: family, weight, style',
      });
    }

    this.fontsService.validateFontFile(file.originalname);
    const upload = await this.uploadsService.uploadFile(file, 'fonts');
    
    const createFontDto: CreateFontDto = {
      family: String(family),
      weight: String(weight),
      style: String(style),
    };
    
    return this.fontsService.create(createFontDto, upload.url);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todas as fontes personalizadas' })
  @ApiResponse({ status: 200, description: 'Lista de fontes' })
  findAll() {
    return this.fontsService.findAll();
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove uma fonte' })
  @ApiResponse({ status: 200, description: 'Fonte removida' })
  remove(@Param('id') id: string) {
    return this.fontsService.remove(id).then(() => ({
      message: 'Fonte removida com sucesso',
    }));
  }
}
