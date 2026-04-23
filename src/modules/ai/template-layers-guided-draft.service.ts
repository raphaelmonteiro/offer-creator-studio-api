import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CreateTemplateLayersGuidedDraftRequestDto,
  GuidedTemplateBackgroundType,
  TemplateLayersGuidedReservedAreaDto,
  GuidedTemplateSection,
  GuidedTemplateStep,
  GUIDED_TEMPLATE_SECTIONS,
  TemplateLayersGuidedBackgroundDto,
  TemplateLayersGuidedDraftDto,
  TemplateLayersGuidedDraftResultDto,
  TemplateLayersGuidedPreviewBackgroundDto,
  TemplateLayersGuidedPreviewDto,
  TemplateLayersGuidedSectionBackgroundsDto,
  TemplateLayersGuidedStyleProfileDto,
  TemplateLayersGuidedStructureDto,
  UpdateTemplateLayersGuidedBackgroundsRequestDto,
  UpdateTemplateLayersGuidedElementsRequestDto,
  UpdateTemplateLayersGuidedStyleRequestDto,
  UpdateTemplateLayersGuidedStructureRequestDto,
} from './dto/template-layers-guided-draft.dto';

const PX_PER_CM = 37.795;
const DEFAULT_BACKGROUND_COLOR = '#F5F5F5';

@Injectable()
export class TemplateLayersGuidedDraftService {
  createDraft(
    request: CreateTemplateLayersGuidedDraftRequestDto,
  ): TemplateLayersGuidedDraftResultDto {
    const normalizedStructure = this.normalizeStructure(request.structure);
    const draft = this.normalizeDraft({
      structure: normalizedStructure,
      globalBackground: request.globalBackground,
      sectionBackgrounds: request.sectionBackgrounds,
      styleProfile: request.styleProfile,
      version: 1,
      currentStep: this.resolveCurrentStep(
        normalizedStructure,
        request.globalBackground,
        request.sectionBackgrounds,
      ),
    });

    return {
      assistantMessage: 'Estrutura inicial do draft guiado criada com sucesso.',
      preview: this.buildPreview(draft),
      nextStep: this.resolveNextStep(draft),
      draft,
    };
  }

  updateStructure(
    request: UpdateTemplateLayersGuidedStructureRequestDto,
  ): TemplateLayersGuidedDraftResultDto {
    const normalizedStructure = this.normalizeStructure(request.structure);
    const draft = this.normalizeDraft({
      ...request.draft,
      structure: normalizedStructure,
      version: (request.draft.version ?? 1) + 1,
    });

    return {
      assistantMessage: 'Estrutura do draft guiado atualizada.',
      preview: this.buildPreview(draft),
      nextStep: this.resolveNextStep(draft),
      draft,
    };
  }

  updateBackgrounds(
    request: UpdateTemplateLayersGuidedBackgroundsRequestDto,
  ): TemplateLayersGuidedDraftResultDto {
    const mergedSectionBackgrounds = {
      ...request.draft.sectionBackgrounds,
      ...request.sectionBackgrounds,
    };

    const draft = this.normalizeDraft({
      ...request.draft,
      globalBackground: request.globalBackground ?? request.draft.globalBackground,
      sectionBackgrounds: mergedSectionBackgrounds,
      version: (request.draft.version ?? 1) + 1,
    });

    return {
      assistantMessage: 'Fundos do draft guiado atualizados.',
      preview: this.buildPreview(draft),
      nextStep: this.resolveNextStep(draft),
      draft,
    };
  }

  updateStyle(
    request: UpdateTemplateLayersGuidedStyleRequestDto,
  ): TemplateLayersGuidedDraftResultDto {
    const draft = this.normalizeDraft({
      ...request.draft,
      styleProfile: this.normalizeStyleProfile(request.styleProfile ?? request.draft.styleProfile),
      reservedAreas: this.normalizeReservedAreas(request.reservedAreas ?? request.draft.reservedAreas),
      version: (request.draft.version ?? 1) + 1,
    });

    return {
      assistantMessage: 'Perfil visual do draft guiado atualizado.',
      preview: this.buildPreview(draft),
      nextStep: this.resolveNextStep(draft),
      draft,
    };
  }

  updateElements(
    request: UpdateTemplateLayersGuidedElementsRequestDto,
  ): TemplateLayersGuidedDraftResultDto {
    const draft = this.normalizeDraft({
      ...request.draft,
      elements: request.elements ?? request.draft.elements,
      lockedSections: request.lockedSections ?? request.draft.lockedSections,
      lockedElementIds: request.lockedElementIds ?? request.draft.lockedElementIds,
      version: (request.draft.version ?? 1) + 1,
    });

    return {
      assistantMessage: 'Elementos do draft guiado atualizados.',
      preview: this.buildPreview(draft),
      nextStep: this.resolveNextStep(draft),
      draft,
    };
  }

  private normalizeDraft(input: TemplateLayersGuidedDraftDto): TemplateLayersGuidedDraftDto {
    const structure = this.normalizeStructure(input.structure);
    const globalBackground = input.globalBackground
      ? this.normalizeBackground(input.globalBackground)
      : undefined;
    const sectionBackgrounds = this.normalizeSectionBackgrounds(input.sectionBackgrounds);
    const styleProfile = this.normalizeStyleProfile(input.styleProfile);
    const reservedAreas = this.normalizeReservedAreas(input.reservedAreas);
    const nextStep = this.resolveCurrentStep(
      structure,
      globalBackground,
      sectionBackgrounds,
      styleProfile,
      reservedAreas,
    );

    return {
      structure,
      globalBackground,
      sectionBackgrounds,
      styleProfile,
      reservedAreas,
      elements: input.elements ?? [],
      lockedSections: input.lockedSections ?? [],
      lockedElementIds: input.lockedElementIds ?? [],
      referenceImages: input.referenceImages ?? [],
      version: Math.max(1, input.version ?? 1),
      currentStep: nextStep,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  private normalizeStructure(
    structure: TemplateLayersGuidedStructureDto,
  ): TemplateLayersGuidedStructureDto {
    const totalHeight = this.roundCm(structure.printHeightCm);
    const totalWidth = this.roundCm(structure.printWidthCm);
    let headerHeightCm =
      structure.layoutMode === 'full' || structure.layoutMode === 'header-only'
        ? this.roundCm(
            structure.headerHeightCm ?? Math.max(2, Number((structure.printHeightCm * 0.25).toFixed(2))),
          )
        : 0;
    let footerHeightCm =
      structure.layoutMode === 'full' || structure.layoutMode === 'footer-only'
        ? this.roundCm(
            structure.footerHeightCm ?? Math.max(1.5, Number((structure.printHeightCm * 0.1).toFixed(2))),
          )
        : 0;

    if (structure.layoutMode === 'body-only') {
      headerHeightCm = 0;
      footerHeightCm = 0;
    }

    const bodyHeightCm = this.roundCm(totalHeight - headerHeightCm - footerHeightCm);
    if (bodyHeightCm <= 0) {
      throw new BadRequestException(
        'A soma de header e footer precisa deixar uma altura positiva para o body.',
      );
    }

    return {
      type: structure.type,
      layoutMode: structure.layoutMode,
      printWidthCm: totalWidth,
      printHeightCm: totalHeight,
      headerHeightCm,
      footerHeightCm,
    };
  }

  private normalizeSectionBackgrounds(
    sectionBackgrounds?: TemplateLayersGuidedSectionBackgroundsDto,
  ): TemplateLayersGuidedSectionBackgroundsDto {
    return {
      header: sectionBackgrounds?.header
        ? this.normalizeBackground(sectionBackgrounds.header)
        : undefined,
      body: sectionBackgrounds?.body ? this.normalizeBackground(sectionBackgrounds.body) : undefined,
      footer: sectionBackgrounds?.footer
        ? this.normalizeBackground(sectionBackgrounds.footer)
        : undefined,
    };
  }

  private normalizeBackground(
    background: TemplateLayersGuidedBackgroundDto,
  ): TemplateLayersGuidedBackgroundDto {
    const type = background.type;
    if (type === 'solid') {
      return {
        type,
        color: background.color ?? DEFAULT_BACKGROUND_COLOR,
        intensity: background.intensity ?? 'balanced',
        notes: background.notes,
      };
    }

    if (type === 'gradient') {
      return {
        type,
        gradientStart: background.gradientStart ?? background.color ?? '#FFFFFF',
        gradientEnd: background.gradientEnd ?? '#D9D9D9',
        gradientAngle: background.gradientAngle ?? 180,
        intensity: background.intensity ?? 'balanced',
        notes: background.notes,
      };
    }

    return {
      type,
      images: background.images ?? [],
      intensity: background.intensity ?? 'balanced',
      color: background.color ?? DEFAULT_BACKGROUND_COLOR,
      notes: background.notes,
    };
  }

  private normalizeStyleProfile(
    styleProfile?: TemplateLayersGuidedStyleProfileDto,
  ): TemplateLayersGuidedStyleProfileDto | undefined {
    if (!styleProfile) return undefined;

    const normalized: TemplateLayersGuidedStyleProfileDto = {};
    if (styleProfile.styleMode) normalized.styleMode = styleProfile.styleMode;
    if (styleProfile.theme?.trim()) normalized.theme = styleProfile.theme.trim();
    if (styleProfile.density) normalized.density = styleProfile.density;
    if (styleProfile.focusSection) normalized.focusSection = styleProfile.focusSection;
    if (styleProfile.customStylePrompt?.trim()) {
      normalized.customStylePrompt = styleProfile.customStylePrompt.trim();
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeReservedAreas(
    reservedAreas?: TemplateLayersGuidedReservedAreaDto[],
  ): TemplateLayersGuidedReservedAreaDto[] {
    if (!reservedAreas?.length) return [];

    return reservedAreas
      .map((area) => ({
        section: area.section,
        purpose: area.purpose.trim(),
        align: area.align ?? 'center',
        widthPct: area.widthPct ? Math.max(5, Math.min(100, Number(area.widthPct.toFixed(2)))) : 30,
        notes: area.notes?.trim() || undefined,
      }))
      .filter((area) => area.purpose.length > 0);
  }

  private buildPreview(draft: TemplateLayersGuidedDraftDto): TemplateLayersGuidedPreviewDto {
    const widthPx = this.toPx(draft.structure.printWidthCm);
    const heightPx = this.toPx(draft.structure.printHeightCm);
    const bodyHeightCm = this.roundCm(
      draft.structure.printHeightCm -
        (draft.structure.headerHeightCm ?? 0) -
        (draft.structure.footerHeightCm ?? 0),
    );

    const sections = GUIDED_TEMPLATE_SECTIONS.map((section) => {
      const active = this.isSectionActive(draft.structure, section);
      const heightCm = this.getSectionHeightCm(draft.structure, section, bodyHeightCm);
      return {
        section,
        active,
        widthCm: draft.structure.printWidthCm,
        heightCm,
        widthPx,
        heightPx: this.toPx(heightCm),
        background: this.resolvePreviewBackground(draft, section),
      };
    });

    return {
      widthPx,
      heightPx,
      bodyHeightCm,
      sections,
    };
  }

  private resolvePreviewBackground(
    draft: TemplateLayersGuidedDraftDto,
    section: GuidedTemplateSection,
  ): TemplateLayersGuidedPreviewBackgroundDto {
    const override = draft.sectionBackgrounds?.[section];
    if (override) {
      return {
        ...this.toPreviewBackground(override),
        source: 'override',
      };
    }

    if (draft.globalBackground) {
      return {
        ...this.toPreviewBackground(draft.globalBackground),
        source: 'global',
      };
    }

    return {
      type: 'default',
      color: DEFAULT_BACKGROUND_COLOR,
      source: 'default',
    };
  }

  private toPreviewBackground(
    background: TemplateLayersGuidedBackgroundDto,
  ): Omit<TemplateLayersGuidedPreviewBackgroundDto, 'source'> {
    return {
      type: background.type as GuidedTemplateBackgroundType,
      color: background.color,
      gradientStart: background.gradientStart,
      gradientEnd: background.gradientEnd,
      gradientAngle: background.gradientAngle,
      images: background.images,
      intensity: background.intensity,
      notes: background.notes,
    };
  }

  private resolveCurrentStep(
    structure: TemplateLayersGuidedStructureDto,
    globalBackground?: TemplateLayersGuidedBackgroundDto,
    sectionBackgrounds?: TemplateLayersGuidedSectionBackgroundsDto,
    styleProfile?: TemplateLayersGuidedStyleProfileDto,
    reservedAreas?: TemplateLayersGuidedReservedAreaDto[],
  ): GuidedTemplateStep {
    if (!structure.type) return 'structure';
    if (!globalBackground) return 'background-base';

    const hasActiveOverride = GUIDED_TEMPLATE_SECTIONS.some((section) => {
      if (!this.isSectionActive(structure, section)) return false;
      return !!sectionBackgrounds?.[section];
    });

    if (!hasActiveOverride) return 'background-overrides';

    const hasStyleSignals = !!(
      styleProfile?.styleMode ||
      styleProfile?.theme ||
      styleProfile?.density ||
      styleProfile?.focusSection ||
      styleProfile?.customStylePrompt ||
      reservedAreas?.length
    );

    if (!hasStyleSignals) return 'style-profile';
    return 'elements';
  }

  private resolveNextStep(draft: TemplateLayersGuidedDraftDto): GuidedTemplateStep {
    return draft.currentStep ?? 'background-base';
  }

  private isSectionActive(
    structure: TemplateLayersGuidedStructureDto,
    section: GuidedTemplateSection,
  ): boolean {
    if (section === 'body') return true;
    if (section === 'header') {
      return structure.layoutMode === 'full' || structure.layoutMode === 'header-only';
    }
    return structure.layoutMode === 'full' || structure.layoutMode === 'footer-only';
  }

  private getSectionHeightCm(
    structure: TemplateLayersGuidedStructureDto,
    section: GuidedTemplateSection,
    bodyHeightCm: number,
  ): number {
    if (section === 'header') return structure.headerHeightCm ?? 0;
    if (section === 'footer') return structure.footerHeightCm ?? 0;
    return bodyHeightCm;
  }

  private toPx(valueCm: number): number {
    return Math.round(valueCm * PX_PER_CM);
  }

  private roundCm(value: number): number {
    return Number(value.toFixed(2));
  }
}
