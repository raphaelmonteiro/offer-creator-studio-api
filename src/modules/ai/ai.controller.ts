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
import {
  CreateTemplateLayersGuidedDraftRequestDto,
  UpdateTemplateLayersGuidedBackgroundsRequestDto,
  UpdateTemplateLayersGuidedElementsRequestDto,
  UpdateTemplateLayersGuidedStyleRequestDto,
  UpdateTemplateLayersGuidedStructureRequestDto,
} from './dto/template-layers-guided-draft.dto';
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

  @Post('template-layers-guided-draft')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cria o draft guiado inicial para camadas editáveis' })
  @ApiResponse({ status: 200, description: 'Draft guiado criado com sucesso' })
  async templateLayersGuidedDraftCreate(@Body() dto: CreateTemplateLayersGuidedDraftRequestDto) {
    try {
      const result = this.aiService.createTemplateLayersGuidedDraft(dto);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao criar draft guiado de template em camadas', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_LAYERS_GUIDED_DRAFT_ERROR',
          message: 'Não foi possível criar o draft guiado. Revise a estrutura informada.',
        },
      };
    }
  }

  @Post('template-layers-guided-structure')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atualiza a estrutura do draft guiado para camadas editáveis' })
  @ApiResponse({ status: 200, description: 'Estrutura do draft atualizada com sucesso' })
  async templateLayersGuidedStructureUpdate(
    @Body() dto: UpdateTemplateLayersGuidedStructureRequestDto,
  ) {
    try {
      const result = this.aiService.updateTemplateLayersGuidedStructure(dto);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao atualizar estrutura do draft guiado', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_LAYERS_GUIDED_STRUCTURE_ERROR',
          message: 'Não foi possível atualizar a estrutura do draft guiado.',
        },
      };
    }
  }

  @Post('template-layers-guided-backgrounds')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atualiza fundos globais e por seção do draft guiado' })
  @ApiResponse({ status: 200, description: 'Fundos do draft guiado atualizados com sucesso' })
  async templateLayersGuidedBackgroundsUpdate(
    @Body() dto: UpdateTemplateLayersGuidedBackgroundsRequestDto,
  ) {
    try {
      const result = this.aiService.updateTemplateLayersGuidedBackgrounds(dto);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao atualizar fundos do draft guiado', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_LAYERS_GUIDED_BACKGROUNDS_ERROR',
          message: 'Não foi possível atualizar os fundos do draft guiado.',
        },
      };
    }
  }

  @Post('template-layers-guided-style')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atualiza perfil visual e áreas reservadas do draft guiado' })
  @ApiResponse({ status: 200, description: 'Perfil visual do draft guiado atualizado com sucesso' })
  async templateLayersGuidedStyleUpdate(@Body() dto: UpdateTemplateLayersGuidedStyleRequestDto) {
    try {
      const result = this.aiService.updateTemplateLayersGuidedStyle(dto);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao atualizar perfil visual do draft guiado', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_LAYERS_GUIDED_STYLE_ERROR',
          message: 'Não foi possível atualizar o perfil visual do draft guiado.',
        },
      };
    }
  }

  @Post('template-layers-guided-elements')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atualiza elementos e locks do draft guiado' })
  @ApiResponse({ status: 200, description: 'Elementos do draft guiado atualizados com sucesso' })
  async templateLayersGuidedElementsUpdate(
    @Body() dto: UpdateTemplateLayersGuidedElementsRequestDto,
  ) {
    try {
      const result = this.aiService.updateTemplateLayersGuidedElements(dto);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Erro ao atualizar elementos do draft guiado', error);
      return {
        success: false,
        error: {
          code: 'TEMPLATE_LAYERS_GUIDED_ELEMENTS_ERROR',
          message: 'Não foi possível atualizar os elementos do draft guiado.',
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
