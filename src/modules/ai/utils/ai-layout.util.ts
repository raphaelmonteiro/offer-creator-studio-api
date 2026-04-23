import { LayerBodyBackgroundDto, LayerElementDto } from '../dto/template-layers-generate.dto';

export type LayoutSection = 'header' | 'footer';
export type LayoutNormalizationTarget = 'element' | 'background';

export interface LayoutBounds {
  canvasWidthPx: number;
  headerHeightPx: number;
  footerHeightPx: number;
}

export interface LayoutNormalizationAdjustment {
  target: LayoutNormalizationTarget;
  field: string;
  reason: string;
  from: unknown;
  to: unknown;
  section?: LayoutSection | 'body';
  elementId?: string;
}

export interface NormalizeLayerElementsResult {
  elements: LayerElementDto[];
  adjustments: LayoutNormalizationAdjustment[];
}

export interface NormalizeLayerBackgroundsResult {
  bodyBackground: LayerBodyBackgroundDto;
  footerBackground: LayerBodyBackgroundDto;
  adjustments: LayoutNormalizationAdjustment[];
}

export interface NormalizeTemplateConfigurationResult {
  configuration: Record<string, unknown>;
  adjustments: LayoutNormalizationAdjustment[];
}

interface ElementNormalizationOptions extends LayoutBounds {
  section: unknown;
  fallbackZIndex: number;
  elementId?: string;
}

const DEFAULT_BODY_COLOR = '#FFFFFF';
const DEFAULT_BODY_GRADIENT_START = '#FFFFFF';
const DEFAULT_BODY_GRADIENT_END = '#F3F4F6';
const DEFAULT_FOOTER_COLOR = '#111827';
const MAX_Z_INDEX = 100;

export function normalizeLayerElements(
  elements: LayerElementDto[],
  bounds: LayoutBounds,
): NormalizeLayerElementsResult {
  const adjustments: LayoutNormalizationAdjustment[] = [];

  const normalized = elements.map((element, index) => {
    const result = normalizeElementRecord(
      element as unknown as Record<string, unknown>,
      {
        ...bounds,
        section: element.section,
        fallbackZIndex: index + 1,
        elementId: element.id,
      },
      adjustments,
    );

    return {
      ...element,
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
      section: result.section,
      zIndex: result.zIndex,
    };
  });

  return { elements: normalized, adjustments };
}

export function normalizeLayerBackgrounds(
  bodyBackground: LayerBodyBackgroundDto,
  footerBackground: LayerBodyBackgroundDto,
): NormalizeLayerBackgroundsResult {
  const adjustments: LayoutNormalizationAdjustment[] = [];

  return {
    bodyBackground: normalizeBackgroundRecord(
      bodyBackground as unknown as Record<string, unknown>,
      'body',
      DEFAULT_BODY_COLOR,
      adjustments,
    ) as unknown as LayerBodyBackgroundDto,
    footerBackground: normalizeBackgroundRecord(
      footerBackground as unknown as Record<string, unknown>,
      'footer',
      DEFAULT_FOOTER_COLOR,
      adjustments,
    ) as unknown as LayerBodyBackgroundDto,
    adjustments,
  };
}

export function normalizeTemplateConfigurationLayout(
  configuration: Record<string, unknown>,
  bounds: LayoutBounds,
): NormalizeTemplateConfigurationResult {
  const adjustments: LayoutNormalizationAdjustment[] = [];
  const normalizedConfiguration = { ...configuration };

  for (const section of ['header', 'footer'] as const) {
    const sectionValue = normalizedConfiguration[section];
    if (!isRecord(sectionValue)) continue;

    const normalizedSection = { ...sectionValue };
    normalizedSection.background = isRecord(normalizedSection.background)
      ? normalizeBackgroundRecord(
          normalizedSection.background,
          section,
          section === 'footer' ? DEFAULT_FOOTER_COLOR : DEFAULT_BODY_COLOR,
          adjustments,
        )
      : normalizedSection.background;

    if (Array.isArray(normalizedSection.elements)) {
      normalizedSection.elements = normalizedSection.elements.map((item, index) => {
        if (!isRecord(item)) return item;
        const result = normalizeElementRecord(
          item,
          {
            ...bounds,
            section,
            fallbackZIndex: index + 1,
            elementId: typeof item.id === 'string' ? item.id : undefined,
          },
          adjustments,
        );

        return {
          ...item,
          x: result.x,
          y: result.y,
          width: result.width,
          height: result.height,
          zIndex: result.zIndex,
        };
      });
    }

    normalizedConfiguration[section] = normalizedSection;
  }

  const bodyBackground = normalizedConfiguration.bodyBackground;
  if (isRecord(bodyBackground)) {
    normalizedConfiguration.bodyBackground = normalizeBackgroundRecord(
      bodyBackground,
      'body',
      DEFAULT_BODY_COLOR,
      adjustments,
    );
  }

  return { configuration: normalizedConfiguration, adjustments };
}

export function normalizeCanvasElementRecord(
  element: Record<string, unknown>,
  bounds: LayoutBounds,
  section: unknown,
  fallbackZIndex: number,
): { element: Record<string, unknown>; adjustments: LayoutNormalizationAdjustment[] } {
  const adjustments: LayoutNormalizationAdjustment[] = [];
  const result = normalizeElementRecord(
    element,
    {
      ...bounds,
      section,
      fallbackZIndex,
      elementId: typeof element.id === 'string' ? element.id : undefined,
    },
    adjustments,
  );

  return {
    element: {
      ...element,
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
      zIndex: result.zIndex,
    },
    adjustments,
  };
}

export function normalizeCanvasBackgroundRecord(
  background: Record<string, unknown>,
  section: LayoutSection | 'body',
  solidFallbackColor = section === 'footer' ? DEFAULT_FOOTER_COLOR : DEFAULT_BODY_COLOR,
): { background: Record<string, unknown>; adjustments: LayoutNormalizationAdjustment[] } {
  const adjustments: LayoutNormalizationAdjustment[] = [];
  return {
    background: normalizeBackgroundRecord(
      background,
      section,
      solidFallbackColor,
      adjustments,
    ),
    adjustments,
  };
}

function normalizeElementRecord(
  element: Record<string, unknown>,
  options: ElementNormalizationOptions,
  adjustments: LayoutNormalizationAdjustment[],
) {
  const section = normalizeSection(options.section, options.elementId, adjustments);
  const sectionHeightPx = section === 'header' ? options.headerHeightPx : options.footerHeightPx;

  const minWidth = boundedMinimum(Math.round(options.canvasWidthPx * 0.04), options.canvasWidthPx);
  const minHeight = boundedMinimum(Math.round(sectionHeightPx * 0.12), sectionHeightPx);
  const maxWidth = Math.max(minWidth, Math.round(options.canvasWidthPx * 0.85));
  const maxHeight = Math.max(minHeight, Math.round(sectionHeightPx * 0.95));

  const fallbackWidth = Math.max(minWidth, Math.round(options.canvasWidthPx * 0.25));
  const rawWidth = finiteNumber(element.width, fallbackWidth);
  const width = clampRounded(rawWidth, minWidth, maxWidth);
  recordAdjustment(adjustments, {
    target: 'element',
    section,
    elementId: options.elementId,
    field: 'width',
    from: element.width,
    to: width,
    reason: 'out-of-bounds-width',
  });

  const fallbackHeight = Math.max(minHeight, Math.round(width * 0.8));
  const rawHeight = finiteNumber(element.height, fallbackHeight);
  const height = clampRounded(rawHeight, minHeight, maxHeight);
  recordAdjustment(adjustments, {
    target: 'element',
    section,
    elementId: options.elementId,
    field: 'height',
    from: element.height,
    to: height,
    reason: 'out-of-bounds-height',
  });

  const maxX = Math.max(0, options.canvasWidthPx - width);
  const x = clampRounded(finiteNumber(element.x, 0), 0, maxX);
  recordAdjustment(adjustments, {
    target: 'element',
    section,
    elementId: options.elementId,
    field: 'x',
    from: element.x,
    to: x,
    reason: 'out-of-section-x',
  });

  const maxY = Math.max(0, sectionHeightPx - height);
  const y = clampRounded(finiteNumber(element.y, 0), 0, maxY);
  recordAdjustment(adjustments, {
    target: 'element',
    section,
    elementId: options.elementId,
    field: 'y',
    from: element.y,
    to: y,
    reason: 'out-of-section-y',
  });

  const zIndex = clampRounded(finiteNumber(element.zIndex, options.fallbackZIndex), 1, MAX_Z_INDEX);
  recordAdjustment(adjustments, {
    target: 'element',
    section,
    elementId: options.elementId,
    field: 'zIndex',
    from: element.zIndex,
    to: zIndex,
    reason: 'out-of-range-z-index',
  });

  return { x, y, width, height, section, zIndex };
}

function normalizeSection(
  value: unknown,
  elementId: string | undefined,
  adjustments: LayoutNormalizationAdjustment[],
): LayoutSection {
  if (value === 'header' || value === 'footer') return value;

  const fallback: LayoutSection = 'header';
  recordAdjustment(adjustments, {
    target: 'element',
    section: fallback,
    elementId,
    field: 'section',
    from: value,
    to: fallback,
    reason: 'invalid-section',
  });
  return fallback;
}

function normalizeBackgroundRecord(
  background: Record<string, unknown>,
  section: LayoutSection | 'body',
  solidFallbackColor: string,
  adjustments: LayoutNormalizationAdjustment[],
): Record<string, unknown> {
  if (background.type === 'solid') {
    return normalizeSolidBackground(background, section, solidFallbackColor, adjustments);
  }

  if (background.type === 'gradient') {
    return normalizeGradientBackground(background, section, adjustments);
  }

  if (background.type === 'image') {
    return normalizeImageBackground(background, section, adjustments);
  }

  recordAdjustment(adjustments, {
    target: 'background',
    section,
    field: 'type',
    from: background.type,
    to: 'solid',
    reason: 'invalid-background-type',
  });
  return { type: 'solid', color: solidFallbackColor };
}

function normalizeSolidBackground(
  background: Record<string, unknown>,
  section: LayoutSection | 'body',
  fallbackColor: string,
  adjustments: LayoutNormalizationAdjustment[],
): Record<string, unknown> {
  const color = normalizeHexColor(background.color, fallbackColor);
  recordAdjustment(adjustments, {
    target: 'background',
    section,
    field: 'color',
    from: background.color,
    to: color,
    reason: 'invalid-hex-color',
  });

  return { ...background, type: 'solid', color };
}

function normalizeGradientBackground(
  background: Record<string, unknown>,
  section: LayoutSection | 'body',
  adjustments: LayoutNormalizationAdjustment[],
): Record<string, unknown> {
  const fallbackStart =
    normalizeHexColor(background.color, DEFAULT_BODY_GRADIENT_START) ?? DEFAULT_BODY_GRADIENT_START;
  const gradientStart = normalizeHexColor(background.gradientStart, fallbackStart);
  const gradientEnd = normalizeHexColor(background.gradientEnd, DEFAULT_BODY_GRADIENT_END);
  const gradientAngle = clampRounded(finiteNumber(background.gradientAngle, 180), 0, 360);

  recordAdjustment(adjustments, {
    target: 'background',
    section,
    field: 'gradientStart',
    from: background.gradientStart,
    to: gradientStart,
    reason: 'invalid-hex-color',
  });
  recordAdjustment(adjustments, {
    target: 'background',
    section,
    field: 'gradientEnd',
    from: background.gradientEnd,
    to: gradientEnd,
    reason: 'invalid-hex-color',
  });
  recordAdjustment(adjustments, {
    target: 'background',
    section,
    field: 'gradientAngle',
    from: background.gradientAngle,
    to: gradientAngle,
    reason: 'out-of-range-gradient-angle',
  });

  return {
    ...background,
    type: 'gradient',
    gradientStart,
    gradientEnd,
    gradientAngle,
  };
}

function normalizeImageBackground(
  background: Record<string, unknown>,
  section: LayoutSection | 'body',
  adjustments: LayoutNormalizationAdjustment[],
): Record<string, unknown> {
  const imageOpacity = clampRounded(finiteNumber(background.imageOpacity, 100), 0, 100);
  recordAdjustment(adjustments, {
    target: 'background',
    section,
    field: 'imageOpacity',
    from: background.imageOpacity,
    to: imageOpacity,
    reason: 'out-of-range-image-opacity',
  });

  return {
    ...background,
    type: 'image',
    imageOpacity,
  };
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;

  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();

  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }

  return fallback;
}

function boundedMinimum(candidate: number, upperBound: number): number {
  return Math.max(1, Math.min(Math.max(24, candidate), Math.max(1, Math.round(upperBound))));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampRounded(value: number, min: number, max: number): number {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.round(Math.min(safeMax, Math.max(safeMin, value)));
}

function recordAdjustment(
  adjustments: LayoutNormalizationAdjustment[],
  adjustment: LayoutNormalizationAdjustment,
): void {
  if (Object.is(adjustment.from, adjustment.to)) return;
  adjustments.push(adjustment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
