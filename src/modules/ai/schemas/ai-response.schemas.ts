import { CorrectionDto } from '../dto/spell-check-response.dto';
import { ElementAction, TemplateElementResponseDto } from '../dto/template-element-request.dto';
import {
  ProductCategoryAssignmentDto,
  ProductCategoryAssignmentSource,
} from '../dto/product-categorization-response.dto';
import {
  FlyerAssemblyPagePlanDto,
  FlyerAssemblySectionLayout,
  FlyerAssemblySectionPlanDto,
} from '../dto/flyer-assembly-plan-response.dto';

export const AI_RESPONSE_SCHEMA_VERSION = 'v1';

export const AI_RESPONSE_SCHEMAS = {
  version: AI_RESPONSE_SCHEMA_VERSION,
  spellCheck: {
    required: ['corrections'],
    correctionFields: ['name', 'observation', 'badgeText'],
  },
  productCategorization: {
    required: ['assignments'],
    assignmentSources: ['ai', 'existing', 'fallback'],
  },
  flyerAssemblyPlan: {
    required: ['pages', 'unplacedProductIds', 'notes'],
    sectionLayouts: ['balanced-grid', 'dense-grid', 'hero-grid'],
  },
  templateConfiguration: {
    required: ['assistantMessage', 'configuration'],
    requiredSections: ['header', 'footer'],
  },
  templateElementActions: {
    required: ['assistantMessage', 'actions'],
    actionTypes: ['add-image', 'add-text', 'update-element', 'remove-element', 'update-background'],
    sections: ['header', 'footer', 'body'],
  },
  templateLayersComposition: {
    required: [
      'palette',
      'backgroundPrompt',
      'elements',
      'bodyBackground',
      'footerBackground',
      'assistantMessagePt',
    ],
    sections: ['header', 'footer'],
    bodyBackgroundTypes: ['solid', 'gradient'],
  },
  imageIntentClassification: {
    required: ['category', 'confidence'],
    categories: [
      'new_full_image',
      'targeted_edit',
      'style_variation',
      'add_layer_element',
      'replace_layer_element',
      'layout_change',
      'text_change',
    ],
  },
} as const;

export const AI_RESPONSE_FORMATS = {
  spellCheck: jsonSchemaResponseFormat('spellcheck_v1', {
    type: 'object',
    additionalProperties: false,
    required: ['corrections'],
    properties: {
      corrections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['productId', 'field', 'original', 'suggestion'],
          properties: {
            productId: { type: 'string' },
            field: { type: 'string', enum: ['name', 'observation', 'badgeText'] },
            original: { type: 'string' },
            suggestion: { type: 'string' },
          },
        },
      },
    },
  }),
  productCategorization: jsonSchemaResponseFormat('product_categorization_v1', {
    type: 'object',
    additionalProperties: false,
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['productId', 'category', 'confidence', 'source', 'reason'],
          properties: {
            productId: { type: 'string' },
            category: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            source: { type: 'string', enum: ['ai', 'existing', 'fallback'] },
            reason: { type: 'string' },
          },
        },
      },
    },
  }),
  flyerAssemblyPlan: jsonSchemaResponseFormat('flyer_assembly_plan_v1', {
    type: 'object',
    additionalProperties: false,
    required: ['pages', 'unplacedProductIds', 'notes'],
    properties: {
      pages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'sections'],
          properties: {
            name: { type: ['string', 'null'] },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'category',
                  'title',
                  'priority',
                  'layout',
                  'productIds',
                  'featuredProductIds',
                ],
                properties: {
                  category: { type: 'string' },
                  title: { type: 'string' },
                  priority: { type: 'number' },
                  layout: {
                    type: 'string',
                    enum: ['balanced-grid', 'dense-grid', 'hero-grid'],
                  },
                  productIds: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  featuredProductIds: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      unplacedProductIds: {
        type: 'array',
        items: { type: 'string' },
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  }),
  templateConfiguration: jsonSchemaResponseFormat(
    'template_configuration_v1',
    {
      type: 'object',
      additionalProperties: false,
      required: ['assistantMessage', 'configuration'],
      properties: {
        assistantMessage: { type: 'string' },
        configuration: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
    false,
  ),
  templateElementActions: jsonSchemaResponseFormat(
    'template_element_actions_v1',
    {
      type: 'object',
      additionalProperties: false,
      required: ['assistantMessage', 'actions'],
      properties: {
        assistantMessage: { type: 'string' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'section', 'element', 'elementId', 'updates', 'background'],
            properties: {
              type: {
                type: 'string',
                enum: [
                  'add-image',
                  'add-text',
                  'update-element',
                  'remove-element',
                  'update-background',
                ],
              },
              section: { type: 'string', enum: ['header', 'footer', 'body'] },
              element: {
                type: ['object', 'null'],
                additionalProperties: true,
              },
              elementId: { type: ['string', 'null'] },
              updates: {
                type: ['object', 'null'],
                additionalProperties: true,
              },
              background: {
                type: ['object', 'null'],
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
    false,
  ),
  imageIntentClassification: jsonSchemaResponseFormat('image_intent_classification_v1', {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'confidence', 'reason'],
    properties: {
      category: {
        type: 'string',
        enum: [
          'new_full_image',
          'targeted_edit',
          'style_variation',
          'add_layer_element',
          'replace_layer_element',
          'layout_change',
          'text_change',
        ],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
    },
  }),
  templateLayersComposition: jsonSchemaResponseFormat('template_layers_composition_v1', {
    type: 'object',
    additionalProperties: false,
    required: [
      'palette',
      'backgroundPrompt',
      'elements',
      'bodyBackground',
      'footerBackground',
      'avoid',
      'styleKeywords',
      'assistantMessagePt',
    ],
    properties: {
      palette: {
        type: 'object',
        additionalProperties: false,
        required: ['primary', 'secondary', 'dark', 'light'],
        properties: {
          primary: { type: 'string' },
          secondary: { type: 'string' },
          dark: { type: 'string' },
          light: { type: 'string' },
        },
      },
      backgroundPrompt: { type: 'string' },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'englishPrompt',
            'section',
            'suggestedPosition',
            'suggestedSizePct',
            'regenerate',
            'positionOnly',
          ],
          properties: {
            id: { type: 'string' },
            englishPrompt: { type: 'string' },
            section: { type: 'string', enum: ['header', 'footer'] },
            suggestedPosition: { type: 'string' },
            suggestedSizePct: { type: 'number' },
            regenerate: { type: ['boolean', 'null'] },
            positionOnly: { type: ['boolean', 'null'] },
          },
        },
      },
      bodyBackground: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'color', 'gradientStart', 'gradientEnd', 'gradientAngle'],
        properties: {
          type: { type: 'string', enum: ['solid', 'gradient'] },
          color: { type: ['string', 'null'] },
          gradientStart: { type: ['string', 'null'] },
          gradientEnd: { type: ['string', 'null'] },
          gradientAngle: { type: ['number', 'null'] },
        },
      },
      footerBackground: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'color'],
        properties: {
          type: { type: 'string', enum: ['solid'] },
          color: { type: 'string' },
        },
      },
      avoid: {
        type: 'array',
        items: { type: 'string' },
      },
      styleKeywords: {
        type: 'array',
        items: { type: 'string' },
      },
      assistantMessagePt: { type: 'string' },
    },
  }),
} as const;

export type ImageIntentCategory =
  (typeof AI_RESPONSE_SCHEMAS.imageIntentClassification.categories)[number];

export interface ImageIntentSchemaResult {
  category: ImageIntentCategory;
  confidence: number;
  reason?: string;
}

export interface TemplateLayersCompositionSchemaResult {
  palette: { primary: string; secondary: string; dark: string; light: string };
  backgroundPrompt: string;
  elements: {
    id: string;
    englishPrompt: string;
    section: 'header' | 'footer';
    suggestedPosition: string;
    suggestedSizePct: number;
    regenerate?: boolean;
    positionOnly?: boolean;
  }[];
  bodyBackground: {
    type: 'solid' | 'gradient';
    color?: string;
    gradientStart?: string;
    gradientEnd?: string;
    gradientAngle?: number;
  };
  footerBackground: { type: 'solid'; color: string };
  avoid?: string[];
  styleKeywords?: string[];
  assistantMessagePt: string;
}

export interface TemplateGenerateSchemaResult {
  assistantMessage: string;
  configuration: Record<string, unknown>;
}

export interface ProductCategorizationSchemaResult {
  assignments: ProductCategoryAssignmentDto[];
}

export interface FlyerAssemblyPlanSchemaResult {
  pages: FlyerAssemblyPagePlanDto[];
  unplacedProductIds: string[];
  notes?: string[];
}

export function parseSpellCheckResponse(raw: string): CorrectionDto[] {
  const parsed = parseJsonObject(raw, 'JSON inválido retornado pela IA');
  const corrections = parsed.corrections;

  if (!Array.isArray(corrections)) {
    throw new Error('Estrutura inesperada retornada pela IA');
  }

  return corrections.map((item) => {
    const correction = asRecord(item, 'Correção inválida retornada pela IA');
    const field = correction.field;
    if (!isCorrectionField(field)) {
      throw new Error('Campo de correção inválido retornado pela IA');
    }

    return {
      productId: stringValue(correction.productId),
      field,
      original: stringValue(correction.original),
      suggestion: stringValue(correction.suggestion),
    };
  });
}

export function parseProductCategorizationResponse(
  raw: string,
): ProductCategorizationSchemaResult {
  const parsed = parseJsonObject(raw, 'JSON inválido retornado pela categorização');
  const assignments = parsed.assignments;

  if (!Array.isArray(assignments)) {
    throw new Error('Estrutura inesperada retornada pela categorização');
  }

  return {
    assignments: assignments.map(validateProductCategoryAssignment),
  };
}

export function parseFlyerAssemblyPlanResponse(raw: string): FlyerAssemblyPlanSchemaResult {
  const parsed = parseJsonObject(raw, 'JSON inválido retornado pela montagem');
  const pages = parsed.pages;
  const unplacedProductIds = parsed.unplacedProductIds;

  if (!Array.isArray(pages) || !Array.isArray(unplacedProductIds)) {
    throw new Error('Estrutura inesperada retornada pela montagem');
  }

  return {
    pages: pages.map(validateFlyerAssemblyPage),
    unplacedProductIds: stringArray(unplacedProductIds) || [],
    notes: stringArray(parsed.notes),
  };
}

export function parseTemplateElementResponse(raw: string): TemplateElementResponseDto {
  const parsed = parseJsonObject(raw, 'JSON inválido retornado pelo GPT-4o');
  const assistantMessage =
    typeof parsed.assistantMessage === 'string' ? parsed.assistantMessage : 'Pronto!';
  const actions = parsed.actions;

  if (!Array.isArray(actions)) {
    throw new Error('Estrutura inválida retornada pelo GPT-4o');
  }

  return {
    assistantMessage,
    actions: actions.map(validateElementAction),
  };
}

export function parseTemplateGenerateResponse(raw: string): TemplateGenerateSchemaResult {
  const parsed = parseJsonObject(raw, 'JSON inválido retornado pelo GPT-4o');

  if (typeof parsed.assistantMessage !== 'string' || !isRecord(parsed.configuration)) {
    throw new Error('Estrutura inválida retornada pelo GPT-4o');
  }

  return {
    assistantMessage: parsed.assistantMessage,
    configuration: parsed.configuration,
  };
}

export function parseImageIntentClassification(raw: string): ImageIntentSchemaResult {
  const parsed = parseJsonObject(raw, 'JSON inválido retornado pela classificação de intenção');
  const category = parsed.category;
  if (!isImageIntentCategory(category)) {
    throw new Error('Categoria de intenção inválida');
  }

  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
  if (confidence === undefined) {
    throw new Error('Confiança de intenção inválida');
  }

  return {
    category,
    confidence,
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
  };
}

export function parseTemplateLayersComposition(raw: string): TemplateLayersCompositionSchemaResult {
  const parsed = parseJsonObject(raw, 'GPT-4o retornou composição inválida (não é JSON)');

  if (
    !isPalette(parsed.palette) ||
    typeof parsed.backgroundPrompt !== 'string' ||
    !Array.isArray(parsed.elements) ||
    !isBodyBackground(parsed.bodyBackground) ||
    !isFooterBackground(parsed.footerBackground)
  ) {
    throw new Error('GPT-4o retornou composição inválida');
  }

  return {
    palette: parsed.palette,
    backgroundPrompt: parsed.backgroundPrompt,
    elements: parsed.elements.map(validateLayerElement),
    bodyBackground: parsed.bodyBackground,
    footerBackground: parsed.footerBackground,
    avoid: stringArray(parsed.avoid),
    styleKeywords: stringArray(parsed.styleKeywords),
    assistantMessagePt:
      typeof parsed.assistantMessagePt === 'string' ? parsed.assistantMessagePt : '',
  };
}

function validateElementAction(item: unknown): ElementAction {
  const action = asRecord(item, 'Ação inválida retornada pelo GPT-4o');
  if (!isElementActionType(action.type) || !isTemplateSection(action.section)) {
    throw new Error('Ação inválida retornada pelo GPT-4o');
  }

  return {
    type: action.type,
    section: action.section,
    element: optionalRecord(action.element),
    elementId: typeof action.elementId === 'string' ? action.elementId : undefined,
    updates: optionalRecord(action.updates),
    background: optionalRecord(action.background),
  };
}

function validateProductCategoryAssignment(item: unknown): ProductCategoryAssignmentDto {
  const assignment = asRecord(item, 'Categorização inválida retornada pela IA');
  if (!isProductCategoryAssignmentSource(assignment.source)) {
    throw new Error('Fonte de categorização inválida retornada pela IA');
  }

  const confidence =
    typeof assignment.confidence === 'number' && Number.isFinite(assignment.confidence)
      ? Math.max(0, Math.min(1, assignment.confidence))
      : undefined;
  if (confidence === undefined) {
    throw new Error('Confiança de categorização inválida retornada pela IA');
  }

  return {
    productId: stringValue(assignment.productId),
    category: stringValue(assignment.category),
    confidence,
    source: assignment.source,
    reason: typeof assignment.reason === 'string' ? assignment.reason : undefined,
  };
}

function validateFlyerAssemblyPage(item: unknown): FlyerAssemblyPagePlanDto {
  const page = asRecord(item, 'Pagina de montagem invalida retornada pela IA');
  if (!Array.isArray(page.sections)) {
    throw new Error('Secoes de montagem invalidas retornadas pela IA');
  }

  return {
    name: typeof page.name === 'string' ? page.name : undefined,
    sections: page.sections.map(validateFlyerAssemblySection),
  };
}

function validateFlyerAssemblySection(item: unknown): FlyerAssemblySectionPlanDto {
  const section = asRecord(item, 'Secao de montagem invalida retornada pela IA');
  if (!isFlyerAssemblySectionLayout(section.layout)) {
    throw new Error('Layout de montagem invalido retornado pela IA');
  }

  return {
    category: stringValue(section.category),
    title: stringValue(section.title),
    priority:
      typeof section.priority === 'number' && Number.isFinite(section.priority)
        ? section.priority
        : 0,
    layout: section.layout,
    productIds: stringArray(section.productIds) || [],
    featuredProductIds: stringArray(section.featuredProductIds) || [],
  };
}

function validateLayerElement(
  item: unknown,
): TemplateLayersCompositionSchemaResult['elements'][number] {
  const element = asRecord(item, 'Elemento de camada inválido');
  if (
    typeof element.id !== 'string' ||
    typeof element.englishPrompt !== 'string' ||
    !isLayerSection(element.section) ||
    typeof element.suggestedPosition !== 'string' ||
    typeof element.suggestedSizePct !== 'number'
  ) {
    throw new Error('Elemento de camada inválido');
  }

  return {
    id: element.id,
    englishPrompt: element.englishPrompt,
    section: element.section,
    suggestedPosition: element.suggestedPosition,
    suggestedSizePct: element.suggestedSizePct,
    regenerate: optionalBoolean(element.regenerate),
    positionOnly: optionalBoolean(element.positionOnly),
  };
}

function jsonSchemaResponseFormat(name: string, schema: Record<string, unknown>, strict = true) {
  return {
    type: 'json_schema' as const,
    json_schema: {
      name,
      strict,
      schema,
    },
  };
}

function parseJsonObject(raw: string, errorMessage: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw), errorMessage);
  } catch {
    throw new Error(errorMessage);
  }
}

function asRecord(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(errorMessage);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function isCorrectionField(value: unknown): value is CorrectionDto['field'] {
  return value === 'name' || value === 'observation' || value === 'badgeText';
}

function isProductCategoryAssignmentSource(
  value: unknown,
): value is ProductCategoryAssignmentSource {
  return value === 'ai' || value === 'existing' || value === 'fallback';
}

function isFlyerAssemblySectionLayout(
  value: unknown,
): value is FlyerAssemblySectionLayout {
  return AI_RESPONSE_SCHEMAS.flyerAssemblyPlan.sectionLayouts.includes(
    value as FlyerAssemblySectionLayout,
  );
}

function isElementActionType(value: unknown): value is ElementAction['type'] {
  return (
    value === 'add-image' ||
    value === 'add-text' ||
    value === 'update-element' ||
    value === 'remove-element' ||
    value === 'update-background'
  );
}

function isTemplateSection(value: unknown): value is ElementAction['section'] {
  return value === 'header' || value === 'footer' || value === 'body';
}

function isLayerSection(value: unknown): value is 'header' | 'footer' {
  return value === 'header' || value === 'footer';
}

function isImageIntentCategory(value: unknown): value is ImageIntentCategory {
  return AI_RESPONSE_SCHEMAS.imageIntentClassification.categories.includes(
    value as ImageIntentCategory,
  );
}

function isPalette(value: unknown): value is TemplateLayersCompositionSchemaResult['palette'] {
  return (
    isRecord(value) &&
    typeof value.primary === 'string' &&
    typeof value.secondary === 'string' &&
    typeof value.dark === 'string' &&
    typeof value.light === 'string'
  );
}

function isBodyBackground(
  value: unknown,
): value is TemplateLayersCompositionSchemaResult['bodyBackground'] {
  return (
    isRecord(value) &&
    (value.type === 'solid' || value.type === 'gradient') &&
    (value.color === undefined || value.color === null || typeof value.color === 'string') &&
    (value.gradientStart === undefined ||
      value.gradientStart === null ||
      typeof value.gradientStart === 'string') &&
    (value.gradientEnd === undefined ||
      value.gradientEnd === null ||
      typeof value.gradientEnd === 'string') &&
    (value.gradientAngle === undefined ||
      value.gradientAngle === null ||
      typeof value.gradientAngle === 'number')
  );
}

function isFooterBackground(
  value: unknown,
): value is TemplateLayersCompositionSchemaResult['footerBackground'] {
  return isRecord(value) && value.type === 'solid' && typeof value.color === 'string';
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}
