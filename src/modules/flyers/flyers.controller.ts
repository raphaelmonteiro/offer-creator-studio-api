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
import { createFileInterceptor } from '../../common/utils/multer.util';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FlyersService } from './flyers.service';
import { CreateFlyerDto } from './dto/create-flyer.dto';
import { UpdateFlyerDto } from './dto/update-flyer.dto';
import { QueryFlyerDto } from './dto/query-flyer.dto';
import { DuplicateFlyerDto } from './dto/duplicate-flyer.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UploadsService } from '../uploads/uploads.service';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Flyers')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyers')
export class FlyersController {
  constructor(
    private readonly flyersService: FlyersService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria um novo encarte' })
  @ApiResponse({ status: 201, description: 'Encarte criado com sucesso' })
  create(@Body() createFlyerDto: CreateFlyerDto) {
    return this.flyersService.create(createFlyerDto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos os encartes' })
  @ApiResponse({ status: 200, description: 'Lista de encartes' })
  findAll(@Query() query: QueryFlyerDto) {
    return this.flyersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retorna um encarte específico' })
  @ApiResponse({ status: 200, description: 'Encarte encontrado' })
  @ApiResponse({ status: 404, description: 'Encarte não encontrado' })
  findOne(@Param('id') id: string) {
    return this.flyersService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um encarte' })
  @ApiResponse({ status: 200, description: 'Encarte atualizado' })
  update(@Param('id') id: string, @Body() updateFlyerDto: UpdateFlyerDto) {
    return this.flyersService.update(id, updateFlyerDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove um encarte' })
  @ApiResponse({ status: 200, description: 'Encarte removido' })
  remove(@Param('id') id: string) {
    return this.flyersService.remove(id).then(() => ({
      message: 'Encarte removido com sucesso',
    }));
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Duplica um encarte' })
  @ApiResponse({ status: 201, description: 'Encarte duplicado com sucesso' })
  duplicate(@Param('id') id: string, @Body() duplicateDto: DuplicateFlyerDto) {
    return this.flyersService.duplicate(id, duplicateDto);
  }

  @Post(':id/thumbnail')
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
      },
    },
  })
  @ApiOperation({ summary: 'Upload/atualiza o thumbnail do encarte' })
  @ApiResponse({ status: 200, description: 'Thumbnail enviado com sucesso' })
  async uploadThumbnail(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const upload = await this.uploadsService.uploadFile(file, 'thumbnails');
    const flyer = await this.flyersService.updateThumbnail(id, upload.url);
    return { thumbnailUrl: flyer.thumbnailUrl };
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'Exporta o encarte em formato específico' })
  @ApiResponse({ status: 200, description: 'Exportação gerada' })
  async export(
    @Param('id') id: string,
    @Query('format') format: string = 'pdf',
    @Query('quality') quality: string = 'high',
  ) {
    return this.flyersService.export(id, format, quality);
  }
}
