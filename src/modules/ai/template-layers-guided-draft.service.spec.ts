import { TemplateLayersGuidedDraftService } from './template-layers-guided-draft.service';

describe('TemplateLayersGuidedDraftService', () => {
  let service: TemplateLayersGuidedDraftService;

  beforeEach(() => {
    service = new TemplateLayersGuidedDraftService();
  });

  it('creates a normalized full-layout draft with inherited preview backgrounds', () => {
    const result = service.createDraft({
      structure: {
        type: 'folheto-20x27',
        layoutMode: 'full',
        printWidthCm: 20,
        printHeightCm: 27,
      },
      globalBackground: {
        type: 'solid',
        color: '#F8E7D1',
      },
    });

    expect(result.draft.structure.headerHeightCm).toBeGreaterThan(0);
    expect(result.draft.structure.footerHeightCm).toBeGreaterThan(0);
    expect(result.preview.sections.find((section) => section.section === 'header')?.background.source).toBe(
      'global',
    );
    expect(result.nextStep).toBe('background-overrides');
  });

  it('forces disabled sections to zero height for body-only drafts', () => {
    const result = service.createDraft({
      structure: {
        type: 'folheto-20x27',
        layoutMode: 'body-only',
        printWidthCm: 20,
        printHeightCm: 27,
        headerHeightCm: 5,
        footerHeightCm: 4,
      },
    });

    expect(result.draft.structure.headerHeightCm).toBe(0);
    expect(result.draft.structure.footerHeightCm).toBe(0);
    expect(result.preview.bodyHeightCm).toBe(27);
    expect(result.preview.sections.find((section) => section.section === 'header')?.active).toBe(
      false,
    );
  });

  it('keeps section overrides above the global background in the preview', () => {
    const created = service.createDraft({
      structure: {
        type: 'folheto-20x27',
        layoutMode: 'footer-only',
        printWidthCm: 20,
        printHeightCm: 27,
      },
      globalBackground: {
        type: 'solid',
        color: '#FFFFFF',
      },
    });

    const result = service.updateBackgrounds({
      draft: created.draft,
      sectionBackgrounds: {
        footer: {
          type: 'gradient',
          gradientStart: '#222222',
          gradientEnd: '#555555',
        },
      },
    });

    const footerSection = result.preview.sections.find((section) => section.section === 'footer');
    expect(footerSection?.background.source).toBe('override');
    expect(footerSection?.background.type).toBe('gradient');
    expect(result.nextStep).toBe('style-profile');
  });

  it('moves the draft forward to elements once style profile is defined', () => {
    const created = service.createDraft({
      structure: {
        type: 'folheto-20x27',
        layoutMode: 'full',
        printWidthCm: 20,
        printHeightCm: 27,
      },
      globalBackground: {
        type: 'solid',
        color: '#FFFFFF',
      },
      sectionBackgrounds: {
        header: {
          type: 'solid',
          color: '#222222',
        },
      },
    });

    const result = service.updateStyle({
      draft: created.draft,
      styleProfile: {
        styleMode: 'advertising',
        theme: 'Churrasco premium',
        density: 'balanced',
        focusSection: 'header',
      },
      reservedAreas: [
        {
          section: 'header',
          purpose: 'Título principal',
          align: 'left',
          widthPct: 38,
        },
      ],
    });

    expect(result.draft.styleProfile?.theme).toBe('Churrasco premium');
    expect(result.draft.reservedAreas).toHaveLength(1);
    expect(result.nextStep).toBe('elements');
  });
});
