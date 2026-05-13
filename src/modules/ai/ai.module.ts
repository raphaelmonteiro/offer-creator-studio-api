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
import { UploadsModule } from '../uploads/uploads.module';
import { GalleryModule } from '../gallery/gallery.module';

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
    { provide: 'GalleryEmbeddingService', useExisting: GalleryEmbeddingService },
  ],
  exports: [GalleryEmbeddingService, 'GalleryEmbeddingService'],
})
export class AiModule {}
