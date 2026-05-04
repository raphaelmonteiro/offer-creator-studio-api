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
import { TemplateLayersGenerateRequestDto } from './dto/template-layers-generate.dto';
import { TemplateElementRequestDto } from './dto/template-element-request.dto';
import { ProductCategorizationRequestDto } from './dto/product-categorization-request.dto';
import { FlyerAssemblyPlanRequestDto } from './dto/flyer-assembly-plan-request.dto';
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

  @Post('product-categorization')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sugere categorias de produtos importados com IA' })
  @ApiResponse({ status: 200, description: 'Categorias sugeridas' })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  async productCategorization(@Body() dto: ProductCategorizationRequestDto) {
    try {
      return await this.aiService.categorizeProducts(dto);
    } catch (error) {
      this.logger.error('Erro ao categorizar produtos', error);
      return {
        success: false,
        error: {
          code: 'PRODUCT_CATEGORIZATION_ERROR',
          message: 'Não foi possível categorizar os produtos. Revise manualmente.',
        },
      };
    }
  }

  @Post('flyer-assembly-plan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gera plano de montagem automática para encarte V2' })
  @ApiResponse({ status: 200, description: 'Plano de montagem gerado' })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  async flyerAssemblyPlan(@Body() dto: FlyerAssemblyPlanRequestDto) {
    try {
      return await this.aiService.createFlyerAssemblyPlan(dto);
    } catch (error) {
      this.logger.error('Erro ao gerar plano de montagem', error);
      return {
        success: false,
        error: {
          code: 'FLYER_ASSEMBLY_PLAN_ERROR',
          message: 'Não foi possível montar o encarte automaticamente.',
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

  @Post('template-layers-generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gera template em camadas separadas via GPT-4o Image (Feature 6)' })
  @ApiResponse({ status: 200, description: 'Camadas geradas com sucesso' })
  async templateLayersGenerate(@Body() dto: TemplateLayersGenerateRequestDto) {
    try {
      const result = await this.aiService.generateTemplateLayers(dto.format, dto.messages);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao gerar template em camadas', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_LAYERS_GENERATION_ERROR',
          message:
            'Não foi possível gerar as camadas. Tente novamente com uma descrição diferente.',
        },
      };
    }
  }


  @Post('template-element')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Adiciona/edita/remove elementos individuais no template via IA' })
  @ApiResponse({ status: 200, description: 'Ações executadas com sucesso' })
  async templateElement(@Body() dto: TemplateElementRequestDto) {
    try {
      const result = await this.aiService.generateTemplateElement(
        dto.format,
        dto.activeSection,
        dto.messages,
        dto.templateContext,
      );
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao processar elemento de template', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_ELEMENT_ERROR',
          message: error instanceof Error ? error.message : 'Erro ao processar elemento.',
        },
      };
    }
  }

  @Post('template-generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gera um template completo via GPT-4o com suporte a GPT Image' })
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
