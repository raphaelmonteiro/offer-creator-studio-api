import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { OpenAiImageService } from './openai-image.service';
import { PixabayService } from './pixabay.service';
import { SpellCheckService } from './spell-check.service';
import { TemplateGenerateService } from './template-generate.service';
import { TemplateElementAssistantService } from './template-element-assistant.service';
import { TemplateImageGeneratorService } from './template-image-generator.service';
import { TemplateLayersGeneratorService } from './template-layers-generator.service';
import { ProductCategorizationService } from './product-categorization.service';
import { FlyerAssemblyPlanService } from './flyer-assembly-plan.service';
import { GalleryEmbeddingService } from './gallery-embedding.service';
import { SocialSectionLayoutService } from './social-section-layout.service';
import { BackgroundRemovalService } from './background-removal.service';
import { UploadsModule } from '../uploads/uploads.module';
import { GalleryModule } from '../gallery/gallery.module';
import { TaxonomyService } from './metadata/taxonomy/taxonomy.service';
import { ImageMetadataService } from './metadata/image-metadata.service';
import { ProductNameParserService } from './metadata/product-name-parser.service';
import { ProductImageMatchV2Service } from './metadata/product-image-match-v2.service';

@Module({
  imports: [UploadsModule, GalleryModule],
  controllers: [AiController],
  providers: [
    AiService,
    OpenAiImageService,
    PixabayService,
    SpellCheckService,
    TemplateGenerateService,
    TemplateElementAssistantService,
    TemplateImageGeneratorService,
    TemplateLayersGeneratorService,
    ProductCategorizationService,
    FlyerAssemblyPlanService,
    GalleryEmbeddingService,
    SocialSectionLayoutService,
    BackgroundRemovalService,
    TaxonomyService,
    ImageMetadataService,
    ProductNameParserService,
    ProductImageMatchV2Service,
    { provide: 'GalleryEmbeddingService', useExisting: GalleryEmbeddingService },
    { provide: 'ImageMetadataService', useExisting: ImageMetadataService },
  ],
  exports: [
    GalleryEmbeddingService,
    'GalleryEmbeddingService',
    'ImageMetadataService',
    // usado pelo módulo de animações para gerar a imagem base do background
    OpenAiImageService,
  ],
})
export class AiModule {}
