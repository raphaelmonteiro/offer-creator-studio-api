import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { GalleryEmbeddingService } from './gallery-embedding.service';
import { SocialSectionLayoutService } from './social-section-layout.service';
import { Public } from '../../common/decorators/public.decorator';
import { SpellCheckRequestDto } from './dto/spell-check-request.dto';
import { ImageSearchRequestDto } from './dto/image-search-request.dto';
import { ImageDownloadRequestDto } from './dto/image-download-request.dto';
import { TemplateGenerateRequestDto } from './dto/template-generate-request.dto';
import { TemplateImageGenerateRequestDto } from './dto/template-image-generate-request.dto';
import { TemplateLayersGenerateRequestDto } from './dto/template-layers-generate.dto';
import { TemplateElementRequestDto } from './dto/template-element-request.dto';
import { ProductCategorizationRequestDto } from './dto/product-categorization-request.dto';
import { FlyerAssemblyPlanRequestDto } from './dto/flyer-assembly-plan-request.dto';
import { ProductImageMatchRequestDto } from './dto/product-image-match-request.dto';
import { ProductImageCandidatesRequestDto } from './dto/product-image-candidates-request.dto';
import { SocialSectionLayoutRequestDto } from './dto/social-section-layout-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('AI')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly aiService: AiService,
    private readonly galleryEmbeddingService: GalleryEmbeddingService,
    private readonly socialSectionLayoutService: SocialSectionLayoutService,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private assertAdminToken(token: string | undefined): void {
    const expected = this.configService.get<string>('ADMIN_API_TOKEN');
    if (!expected) {
      throw new ForbiddenException(
        'ADMIN_API_TOKEN não configurado no servidor.',
      );
    }
    if (!token || token !== expected) {
      throw new ForbiddenException('Token administrativo inválido.');
    }
  }

  @Public()
  @Get('gallery/embedding-stats')
  @ApiOperation({ summary: '[Admin] Conta imagens com e sem embedding' })
  async galleryEmbeddingStats(
    @Headers('x-admin-token') adminToken: string | undefined,
  ) {
    this.assertAdminToken(adminToken);
    const [row] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS "withEmbedding",
         COUNT(*) FILTER (WHERE embedding IS NULL)::int AS missing
       FROM gallery_images`,
    );
    return row;
  }

  @Post('product-image-match')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Busca a melhor imagem da galeria para cada produto via embedding (cosine)',
  })
  @ApiResponse({ status: 200, description: 'Matches com score' })
  async productImageMatch(@Body() dto: ProductImageMatchRequestDto) {
    try {
      return await this.galleryEmbeddingService.findBestImageMatches(
        dto.products,
      );
    } catch (error) {
      this.logger.error('Erro ao buscar imagens por similaridade', error);
      return {
        success: false,
        error: {
          code: 'PRODUCT_IMAGE_MATCH_ERROR',
          message:
            'Não foi possível buscar imagens para os produtos. Tente novamente.',
        },
      };
    }
  }

  @Post('product-image-candidates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lista top-N imagens da galeria mais similares ao nome do produto',
  })
  @ApiResponse({ status: 200, description: 'Lista de candidatas ordenada por score' })
  async productImageCandidates(
    @Body() dto: ProductImageCandidatesRequestDto,
  ) {
    try {
      const candidates =
        await this.galleryEmbeddingService.findImageCandidatesForProduct({
          name: dto.productName,
          category: dto.category,
          unit: dto.unit,
          limit: dto.limit,
        });
      return { candidates };
    } catch (error) {
      this.logger.error('Erro ao listar candidatas de imagem', error);
      return {
        success: false,
        error: {
          code: 'PRODUCT_IMAGE_CANDIDATES_ERROR',
          message:
            'Não foi possível listar as imagens. Tente novamente.',
        },
      };
    }
  }

  @Public()
  @Post('gallery/backfill-embeddings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '[Admin] Gera embeddings para todas as imagens da galeria sem embedding',
  })
  async galleryBackfillEmbeddings(
    @Headers('x-admin-token') adminToken: string | undefined,
    @Body() body: { batchSize?: number } = {},
  ) {
    this.assertAdminToken(adminToken);
    const batchSize = body.batchSize ?? 100;
    const result = await this.galleryEmbeddingService.backfillEmbeddings(
      batchSize,
    );
    return result;
  }

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

  @Post('social-section-layout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reorganiza elementos de header/footer da arte social a partir de uma instrução em linguagem natural',
  })
  @ApiResponse({ status: 200, description: 'Layout reorganizado com sucesso' })
  async socialSectionLayout(@Body() dto: SocialSectionLayoutRequestDto) {
    try {
      const result = await this.socialSectionLayoutService.apply(dto);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao aplicar layout via IA na seção social', error);
      return {
        success: false,
        error: {
          code: 'SOCIAL_SECTION_LAYOUT_ERROR',
          message:
            error instanceof Error
              ? error.message
              : 'Não foi possível reorganizar a seção. Tente reformular.',
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
