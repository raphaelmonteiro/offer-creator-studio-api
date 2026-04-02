import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { SpellCheckRequestDto } from './dto/spell-check-request.dto';
import { ImageSearchRequestDto } from './dto/image-search-request.dto';
import { ImageDownloadRequestDto } from './dto/image-download-request.dto';
import { TemplateGenerateRequestDto } from './dto/template-generate-request.dto';
import { TemplateImageGenerateRequestDto } from './dto/template-image-generate-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('AI')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(private readonly aiService: AiService) {}

  @Post('spell-check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Valida ortografia dos textos dos produtos do encarte' })
  @ApiResponse({ status: 200, description: 'Correções encontradas' })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  async spellCheck(@Body() dto: SpellCheckRequestDto) {
    try {
      const result = await this.aiService.spellCheck(dto.products);
      return result;
    } catch (error) {
      this.logger.error('Erro ao processar spell-check', error);
      return {
        success: false,
        error: {
          code: 'AI_SERVICE_ERROR',
          message: 'Não foi possível processar a validação. Tente novamente.',
        },
      };
    }
  }

  @Get('image-search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Busca imagens no Pixabay para um produto' })
  @ApiResponse({ status: 200, description: 'Lista de imagens sugeridas' })
  async imageSearch(@Query() dto: ImageSearchRequestDto) {
    try {
      const result = await this.aiService.searchImages(dto.rawName, dto.category);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao buscar imagens', error);
      return {
        success: false,
        error: {
          code: 'IMAGE_SEARCH_ERROR',
          message: 'Não foi possível buscar imagens. Tente novamente.',
        },
      };
    }
  }

  @Post('image-download')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Baixa e salva uma imagem do Pixabay no bucket' })
  @ApiResponse({ status: 200, description: 'URL CDN da imagem salva' })
  async imageDownload(@Body() dto: ImageDownloadRequestDto) {
    try {
      const imageUrl = await this.aiService.downloadAndSaveImage(dto.imageUrl, dto.productName);
      return { success: true, data: { imageUrl } };
    } catch (error) {
      this.logger.error('Erro ao baixar imagem', error);
      return {
        success: false,
        error: {
          code: 'IMAGE_DOWNLOAD_ERROR',
          message: 'Não foi possível salvar a imagem. Tente novamente.',
        },
      };
    }
  }

  @Post('template-image-generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gera imagem de fundo para template via GPT-4o Image (Feature 5)' })
  @ApiResponse({ status: 200, description: 'Imagem gerada com sucesso' })
  async templateImageGenerate(@Body() dto: TemplateImageGenerateRequestDto) {
    try {
      const result = await this.aiService.generateTemplateImage(dto.format, dto.messages);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao gerar imagem de template', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_IMAGE_GENERATION_ERROR',
          message: 'Não foi possível gerar a imagem. Tente novamente com uma descrição diferente.',
        },
      };
    }
  }

  @Post('template-generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gera um template completo via GPT-4o com suporte a DALL-E 3' })
  @ApiResponse({ status: 200, description: 'Template gerado com sucesso' })
  async templateGenerate(@Body() dto: TemplateGenerateRequestDto) {
    try {
      const result = await this.aiService.generateTemplate(dto.format, dto.messages);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao gerar template', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_GENERATION_ERROR',
          message:
            'Não foi possível gerar o template. Tente novamente com uma descrição diferente.',
        },
      };
    }
  }
}
