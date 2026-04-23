import { Injectable } from '@nestjs/common';
import { SpellCheckProductDto } from './dto/spell-check-request.dto';
import { SpellCheckResponseDto } from './dto/spell-check-response.dto';
import { ImageSearchResponseDto } from './dto/image-search-response.dto';
import { PixabayCategory } from './dto/image-search-request.dto';
import { FormatDto, ChatMessageDto } from './dto/template-generate-request.dto';
import { TemplateGenerateResponseDto } from './dto/template-generate-response.dto';
import {
  TemplateImageFormatDto,
  TemplateImageMessageDto,
} from './dto/template-image-generate-request.dto';
import {
  TemplateLayersFormatDto,
  TemplateLayersMessageDto,
  TemplateLayersGenerateResponseDto,
} from './dto/template-layers-generate.dto';
import { TemplateElementResponseDto } from './dto/template-element-request.dto';
import { PixabayService } from './pixabay.service';
import { SpellCheckService } from './spell-check.service';
import { TemplateGenerateService } from './template-generate.service';
import { TemplateElementAssistantService } from './template-element-assistant.service';
import { TemplateImageGeneratorService } from './template-image-generator.service';
import { TemplateLayersGeneratorService } from './template-layers-generator.service';

@Injectable()
export class AiService {
  constructor(
    private readonly pixabayService: PixabayService,
    private readonly spellCheckService: SpellCheckService,
    private readonly templateGenerateService: TemplateGenerateService,
    private readonly templateElementAssistantService: TemplateElementAssistantService,
    private readonly templateImageGeneratorService: TemplateImageGeneratorService,
    private readonly templateLayersGeneratorService: TemplateLayersGeneratorService,
  ) {}

  async spellCheck(products: SpellCheckProductDto[]): Promise<SpellCheckResponseDto> {
    return this.spellCheckService.spellCheck(products);
  }

  async searchImages(rawName: string, category?: PixabayCategory): Promise<ImageSearchResponseDto> {
    return this.pixabayService.searchImages(rawName, category);
  }

  async downloadAndSaveImage(imageUrl: string, productName: string): Promise<string> {
    return this.pixabayService.downloadAndSaveImage(imageUrl, productName);
  }

  async generateTemplateElement(
    format: FormatDto,
    activeSection: 'header' | 'footer' | 'body',
    messages: ChatMessageDto[],
    templateContext?: Record<string, unknown>,
  ): Promise<TemplateElementResponseDto> {
    return this.templateElementAssistantService.generateTemplateElement(
      format,
      activeSection,
      messages,
      templateContext,
    );
  }

  async generateTemplate(
    format: FormatDto,
    messages: ChatMessageDto[],
  ): Promise<TemplateGenerateResponseDto> {
    return this.templateGenerateService.generateTemplate(format, messages);
  }

  async generateTemplateImage(
    format: TemplateImageFormatDto,
    messages: TemplateImageMessageDto[],
  ): Promise<{ imageUrl: string; assistantMessage: string; promptUsed: string }> {
    return this.templateImageGeneratorService.generateTemplateImage(format, messages);
  }

  async generateTemplateLayers(
    format: TemplateLayersFormatDto,
    messages: TemplateLayersMessageDto[],
  ): Promise<TemplateLayersGenerateResponseDto> {
    return this.templateLayersGeneratorService.generateTemplateLayers(format, messages);
  }
}
