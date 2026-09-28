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
import { MascotScriptService } from './mascot-script.service';
import { UploadsModule } from '../uploads/uploads.module';
import { GalleryModule } from '../gallery/gallery.module';
import { TaxonomyService } from './metadata/taxonomy/taxonomy.service';
import { ImageMetadataService } from './metadata/image-metadata.service';
import { ProductNameParserService } from './metadata/product-name-parser.service';
import { FilenameMetadataRecoveryService } from './metadata/filename-metadata-recovery.service';
import { OffResolutionService } from './ean/off-resolution.service';
import { SpreadsheetEanMatchService } from './ean/spreadsheet-ean-match.service';
import { ProductImageMatchV2Service } from './metadata/product-image-match-v2.service';
import { SharedModule } from '../../shared/shared.module';
import { EanMatchAdminController, EanReviewController } from './ean/ean-match.controller';
import { EanMatchJobService } from './ean/ean-match-job.service';
import { EanMatchStore } from './ean/ean-match.store';
import { EAN_ITEM_PROCESSOR, EanMatchRunnerService } from './ean/ean-match-runner.service';
import { EanItemPipelineService } from './ean/ean-item-pipeline.service';
import { EanCandidateService } from './ean/ean-candidate.service';
import { EanReferenceService } from './ean/ean-reference.service';
import { EanJudgeService } from './ean/ean-judge.service';
import { EanCalibrationService } from './ean/ean-calibration.service';
import { EanMatchCommitService } from './ean/ean-match-commit.service';
import { EanReviewService } from './ean/ean-review.service';

@Module({
  imports: [UploadsModule, GalleryModule, SharedModule],
  controllers: [AiController, EanMatchAdminController, EanReviewController],
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
    MascotScriptService,
    TaxonomyService,
    ImageMetadataService,
    ProductNameParserService,
    FilenameMetadataRecoveryService,
    OffResolutionService,
    SpreadsheetEanMatchService,
    ProductImageMatchV2Service,
    // Vínculo EAN planilha→galeria (openspec vinculo-ean-planilha-alta-confianca)
    EanMatchJobService,
    EanMatchStore,
    EanMatchRunnerService,
    EanItemPipelineService,
    { provide: EAN_ITEM_PROCESSOR, useExisting: EanItemPipelineService },
    EanCandidateService,
    EanReferenceService,
    EanJudgeService,
    EanCalibrationService,
    EanMatchCommitService,
    EanReviewService,
    { provide: 'GalleryEmbeddingService', useExisting: GalleryEmbeddingService },
    { provide: 'ImageMetadataService', useExisting: ImageMetadataService },
  ],
  exports: [
    GalleryEmbeddingService,
    'GalleryEmbeddingService',
    'ImageMetadataService',
    // usado pelo módulo de animações para gerar a imagem base do background
    OpenAiImageService,
    // usado pelo módulo de mascotes para recortar o fundo do PNG enviado
    BackgroundRemovalService,
  ],
})
export class AiModule {}
