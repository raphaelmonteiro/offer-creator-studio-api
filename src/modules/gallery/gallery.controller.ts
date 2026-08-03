import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
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
import { UpdateImageDto } from './dto/update-image.dto';
import { SetImageClientsDto } from './dto/set-image-clients.dto';
import { BulkImageClientsDto } from './dto/bulk-image-clients.dto';
import { ClientPreferredImagesService } from './client-preferred-images.service';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { fileUploadOptions } from '../../common/utils/multer.util';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Gallery')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('gallery')
export class GalleryController {
  constructor(
    private readonly galleryService: GalleryService,
    private readonly clientPreferredImages: ClientPreferredImagesService,
  ) {}

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

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza metadados de uma imagem' })
  @ApiResponse({ status: 200, description: 'Imagem atualizada com sucesso' })
  updateImage(@Param('id') id: string, @Body() dto: UpdateImageDto) {
    return this.galleryService.updateImage(id, dto);
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

  // Marcação de clientes (Feature 13)
  //
  // Cliente funciona como TAG de curadoria: uma imagem pode ser marcada para N
  // clientes, sem mover arquivo e sem conflitar com a pasta (que é organização).

  @Put('images/:imageId/clients')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Define os clientes de uma imagem (substitui a marcação atual)' })
  @ApiResponse({ status: 200, description: 'Marcação atualizada' })
  setImageClients(
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() dto: SetImageClientsDto,
  ) {
    return this.clientPreferredImages.setClientsForImage(imageId, dto.clientIds);
  }

  @Post('images/clients/bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca/desmarca clientes em várias imagens de uma vez' })
  @ApiResponse({ status: 200, description: 'Marcação aplicada' })
  bulkImageClients(@Body() dto: BulkImageClientsDto) {
    return this.clientPreferredImages.bulkAssign(dto.imageIds, dto.clientIds, dto.mode ?? 'add');
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
