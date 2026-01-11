import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
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
import { UploadsService } from './uploads.service';
import { UploadDto } from './dto/upload.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Uploads')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

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
        folder: {
          type: 'string',
          enum: ['products', 'logos', 'templates', 'general', 'fonts', 'avatars', 'thumbnails'],
          default: 'general',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Upload genérico de arquivos' })
  @ApiResponse({ status: 200, description: 'Arquivo enviado com sucesso' })
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() uploadDto: UploadDto,
  ) {
    return this.uploadsService.uploadFile(file, uploadDto.folder || 'general');
  }
}
