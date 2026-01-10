import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { QueryTemplateDto } from './dto/query-template.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UploadsService } from '../uploads/uploads.service';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Templates')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria um novo template' })
  @ApiResponse({ status: 201, description: 'Template criado com sucesso' })
  create(@Body() createTemplateDto: CreateTemplateDto) {
    return this.templatesService.create(createTemplateDto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos os templates' })
  @ApiResponse({ status: 200, description: 'Lista de templates' })
  findAll(@Query() query: QueryTemplateDto) {
    return this.templatesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retorna um template específico' })
  @ApiResponse({ status: 200, description: 'Template encontrado' })
  @ApiResponse({ status: 404, description: 'Template não encontrado' })
  findOne(@Param('id') id: string) {
    return this.templatesService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um template' })
  @ApiResponse({ status: 200, description: 'Template atualizado' })
  update(@Param('id') id: string, @Body() updateTemplateDto: UpdateTemplateDto) {
    return this.templatesService.update(id, updateTemplateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove um template (apenas templates não-padrão)' })
  @ApiResponse({ status: 200, description: 'Template removido' })
  remove(@Param('id') id: string) {
    return this.templatesService.remove(id).then(() => ({
      message: 'Template removido com sucesso',
    }));
  }

  @Post(':id/thumbnail')
  @SkipValidation()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Upload/atualiza o thumbnail do template' })
  @ApiResponse({ status: 200, description: 'Thumbnail enviado com sucesso' })
  async uploadThumbnail(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const upload = await this.uploadsService.uploadFile(file, 'thumbnails');
    const template = await this.templatesService.updateThumbnail(id, upload.url);
    return { thumbnailUrl: template.thumbnailUrl };
  }
}
