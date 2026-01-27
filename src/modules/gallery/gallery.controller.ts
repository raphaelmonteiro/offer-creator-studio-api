import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  HttpCode,
  HttpStatus,
  Patch,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GalleryService } from './gallery.service';
import { QueryGalleryDto } from './dto/query-gallery.dto';
import { UploadGalleryDto } from './dto/upload-gallery.dto';
import { DeleteManyDto } from './dto/delete-many.dto';
import { MoveImagesDto } from './dto/move-images.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { fileUploadOptions } from '../../common/utils/multer.util';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Gallery')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('gallery')
export class GalleryController {
  constructor(private readonly galleryService: GalleryService) {}

  // Imagens

  @Get()
  @ApiOperation({ summary: 'Lista imagens com paginação e filtros' })
  @ApiResponse({ status: 200, description: 'Lista de imagens' })
  listImages(@Query() query: QueryGalleryDto) {
    return this.galleryService.listImages(query);
  }

  @Post('upload')
  @SkipValidation()
  @UseInterceptors(AnyFilesInterceptor(fileUploadOptions))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
        },
        folderId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
        },
      },
    },
  })
  @ApiOperation({ summary: 'Upload de múltiplas imagens' })
  @ApiResponse({ status: 201, description: 'Imagens enviadas com sucesso' })
  async uploadImages(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: UploadGalleryDto,
  ) {
    return this.galleryService.uploadImages(files, body.folderId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove uma imagem' })
  @ApiResponse({ status: 200, description: 'Imagem removida com sucesso' })
  async deleteImage(@Param('id') id: string) {
    await this.galleryService.deleteImage(id);
    return { success: true };
  }

  @Post('delete-many')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove múltiplas imagens' })
  @ApiResponse({ status: 200, description: 'Imagens removidas com sucesso' })
  deleteMany(@Body() dto: DeleteManyDto) {
    return this.galleryService.deleteMany(dto);
  }

  @Post('move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move imagens para uma pasta' })
  @ApiResponse({ status: 200, description: 'Imagens movidas com sucesso' })
  moveImages(@Body() dto: MoveImagesDto) {
    return this.galleryService.moveImages(dto);
  }

  // Pastas

  @Get('folders')
  @ApiOperation({ summary: 'Lista todas as pastas' })
  @ApiResponse({ status: 200, description: 'Lista de pastas' })
  listFolders() {
    return this.galleryService.listFolders();
  }

  @Post('folders')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria nova pasta' })
  @ApiResponse({ status: 201, description: 'Pasta criada com sucesso' })
  createFolder(@Body() dto: CreateFolderDto) {
    return this.galleryService.createFolder(dto);
  }

  @Patch('folders/:id')
  @ApiOperation({ summary: 'Atualiza pasta' })
  @ApiResponse({ status: 200, description: 'Pasta atualizada com sucesso' })
  updateFolder(@Param('id') id: string, @Body() dto: UpdateFolderDto) {
    return this.galleryService.updateFolder(id, dto);
  }

  @Delete('folders/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove pasta (imagens são movidas para raiz automaticamente)',
  })
  @ApiResponse({ status: 200, description: 'Pasta removida com sucesso' })
  async deleteFolder(@Param('id') id: string) {
    return this.galleryService.deleteFolder(id);
  }
}

