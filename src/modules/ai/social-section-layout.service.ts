import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import { withAiLogging } from './utils/ai-telemetry.util';
import {
  SOCIAL_SECTION_LAYOUT_SYSTEM_PROMPT,
  buildSocialSectionLayoutUserPrompt,
  ALLOWED_FONT_FAMILIES,
} from './prompts/social-section-layout.prompts';
import {
  SocialSectionElementDto,
  SocialSectionLayoutRequestDto,
} from './dto/social-section-layout-request.dto';

/**
 * Shape of a single patch the LLM emits for an element. All fields are
 * optional — only what the LLM wants to change goes in.
 */
export interface SocialSectionLayoutPatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  // text
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
  textAlign?: 'left' | 'center' | 'right';
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  lineHeight?: number;
  letterSpacing?: number;
  textShadow?: {
    offsetX: number;
    offsetY: number;
    blur: number;
    color: string;
  };
  // image
  opacity?: number;
  objectFit?: 'cover' | 'contain' | 'fill' | 'none';
  boxShadow?: {
    offsetX: number;
    offsetY: number;
    blur: number;
    spread: number;
    color: string;
  };
}

export interface SocialSectionLayoutAction {
  targetId: string;
  patch: SocialSectionLayoutPatch;
}

export interface SocialSectionLayoutResponse {
  reasoning: string;
  actions: SocialSectionLayoutAction[];
}

const ALLOWED_FONT_SET = new Set<string>(ALLOWED_FONT_FAMILIES as readonly string[]);

@Injectable()
export class SocialSectionLayoutService {
  private readonly logger = new Logger(SocialSectionLayoutService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;

  constructor(private readonly configService: ConfigService) {
    this.models = getOpenAiModelConfig(configService);
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  /**
   * Apply a user instruction to the section's elements. Returns the patch
   * list that the frontend will use to update the document. The patches
   * are SANITIZED before returning:
   *
   *   - Unknown targetIds (not in the input element list) are discarded.
   *   - Numeric coords are clamped to the section's preview-pixel bounds.
   *   - fontSize is clamped to [12, 80].
   *   - fontFamily is replaced with Inter if not in ALLOWED_FONT_FAMILIES.
   *   - content/src/id/type are NEVER copied into the patch (frontend
   *     would refuse to apply them, but we strip just in case).
   */
  async apply(
    request: SocialSectionLayoutRequestDto,
  ): Promise<SocialSectionLayoutResponse> {
    if (!this.openai) {
      throw new BadRequestException({
        code: 'AI_NOT_CONFIGURED',
        message: 'OpenAI não configurada no servidor.',
      });
    }
    if (request.elements.length === 0) {
      return { reasoning: 'Nenhum elemento para organizar.', actions: [] };
    }

    const userPrompt = buildSocialSectionLayoutUserPrompt(request);

    const response = await withAiLogging(
      this.logger,
      {
        endpoint: 'chat.completions',
        model: this.models.textModel,
        feature: 'social-section-layout',
      },
      () =>
        this.openai!.chat.completions.create({
          model: this.models.textModel,
          temperature: 0.3,
          messages: [
            { role: 'system', content: SOCIAL_SECTION_LAYOUT_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          // We use json_object (not strict schema) because the `patch`
          // payload has dynamic fields — strict schemas would require us
          // to enumerate every possible property at every level.
          response_format: { type: 'json_object' },
        }),
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      throw new Error('LLM response was empty');
    }

    let parsed: { reasoning?: string; actions?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(`Failed to parse LLM JSON: ${raw.slice(0, 200)}`);
      throw new BadRequestException({
        code: 'AI_INVALID_RESPONSE',
        message: 'A IA retornou uma resposta inválida.',
      });
    }

    const elementsById = new Map<string, SocialSectionElementDto>(
      request.elements.map((el) => [el.id, el]),
    );
    const sectionWidth = request.section.widthPreviewPx;
    const sectionHeight = request.section.heightPreviewPx;

    const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
    const actions: SocialSectionLayoutAction[] = [];

    for (const item of rawActions) {
      if (!item || typeof item !== 'object') continue;
      const action = item as { targetId?: unknown; patch?: unknown };
      const targetId = typeof action.targetId === 'string' ? action.targetId : null;
      if (!targetId || !elementsById.has(targetId)) continue;
      if (!action.patch || typeof action.patch !== 'object') continue;

      const element = elementsById.get(targetId)!;
      const sanitized = this.sanitizePatch(
        action.patch as Record<string, unknown>,
        element,
        sectionWidth,
        sectionHeight,
      );
      if (Object.keys(sanitized).length > 0) {
        actions.push({ targetId, patch: sanitized });
      }
    }

    // Single-line summary log — kept for production observability.
    // The detailed per-action logs were removed after the prompt was tuned.
    this.logger.log(
      `[social-section-layout] elements=${request.elements.length} actions_emitted=${rawActions.length} actions_applied=${actions.length}`,
    );

    const reasoning =
      typeof parsed.reasoning === 'string' && parsed.reasoning.length > 0
        ? parsed.reasoning.slice(0, 240)
        : actions.length > 0
          ? 'Layout reorganizado.'
          : 'Não consegui interpretar a instrução — tente reformular.';

    return { reasoning, actions };
  }

  // ─── Sanitization ─────────────────────────────────────────────────────
  private sanitizePatch(
    patch: Record<string, unknown>,
    element: SocialSectionElementDto,
    sectionWidth: number,
    sectionHeight: number,
  ): SocialSectionLayoutPatch {
    const out: SocialSectionLayoutPatch = {};
    const isText = element.type === 'text';
    const isImage = element.type === 'image';

    // Position & size — clamped to section bounds
    const currentWidth = (patch.width as number) ?? element.width;
    const currentHeight = (patch.height as number) ?? element.height;
    if (typeof patch.width === 'number' && isFinite(patch.width)) {
      out.width = Math.max(8, Math.min(sectionWidth, patch.width));
    }
    if (typeof patch.height === 'number' && isFinite(patch.height)) {
      out.height = Math.max(8, Math.min(sectionHeight, patch.height));
    }
    if (typeof patch.x === 'number' && isFinite(patch.x)) {
      const w = out.width ?? currentWidth;
      out.x = Math.max(0, Math.min(sectionWidth - w, patch.x));
    }
    if (typeof patch.y === 'number' && isFinite(patch.y)) {
      const h = out.height ?? currentHeight;
      out.y = Math.max(0, Math.min(sectionHeight - h, patch.y));
    }
    if (typeof patch.zIndex === 'number' && isFinite(patch.zIndex)) {
      out.zIndex = Math.max(0, Math.round(patch.zIndex));
    }

    // Text-only fields
    if (isText) {
      if (typeof patch.fontSize === 'number' && isFinite(patch.fontSize)) {
        out.fontSize = Math.max(12, Math.min(80, Math.round(patch.fontSize)));
      }
      if (typeof patch.fontFamily === 'string') {
        out.fontFamily = ALLOWED_FONT_SET.has(patch.fontFamily)
          ? patch.fontFamily
          : 'Inter, sans-serif';
      }
      if (typeof patch.fontWeight === 'string') {
        // Accept '100'..'900' or 'normal'/'bold'
        if (/^(100|200|300|400|500|600|700|800|900|normal|bold)$/.test(patch.fontWeight)) {
          out.fontWeight = patch.fontWeight;
        }
      }
      if (patch.fontStyle === 'italic' || patch.fontStyle === 'normal') {
        out.fontStyle = patch.fontStyle;
      }
      if (typeof patch.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.color)) {
        out.color = patch.color;
      }
      if (patch.textAlign === 'left' || patch.textAlign === 'center' || patch.textAlign === 'right') {
        out.textAlign = patch.textAlign;
      }
      if (
        patch.textTransform === 'none' ||
        patch.textTransform === 'uppercase' ||
        patch.textTransform === 'lowercase' ||
        patch.textTransform === 'capitalize'
      ) {
        out.textTransform = patch.textTransform;
      }
      if (typeof patch.lineHeight === 'number' && isFinite(patch.lineHeight)) {
        out.lineHeight = Math.max(0.8, Math.min(2.5, patch.lineHeight));
      }
      if (typeof patch.letterSpacing === 'number' && isFinite(patch.letterSpacing)) {
        out.letterSpacing = Math.max(-5, Math.min(20, patch.letterSpacing));
      }
      if (patch.textShadow && typeof patch.textShadow === 'object') {
        const ts = patch.textShadow as Record<string, unknown>;
        if (
          typeof ts.offsetX === 'number' &&
          typeof ts.offsetY === 'number' &&
          typeof ts.blur === 'number' &&
          typeof ts.color === 'string'
        ) {
          out.textShadow = {
            offsetX: ts.offsetX,
            offsetY: ts.offsetY,
            blur: Math.max(0, Math.min(40, ts.blur)),
            color: ts.color,
          };
        }
      }
    }

    // Image-only fields
    if (isImage) {
      if (typeof patch.opacity === 'number' && isFinite(patch.opacity)) {
        out.opacity = Math.max(0, Math.min(100, Math.round(patch.opacity)));
      }
      if (
        patch.objectFit === 'cover' ||
        patch.objectFit === 'contain' ||
        patch.objectFit === 'fill' ||
        patch.objectFit === 'none'
      ) {
        out.objectFit = patch.objectFit;
      }
      if (patch.boxShadow && typeof patch.boxShadow === 'object') {
        const bs = patch.boxShadow as Record<string, unknown>;
        if (
          typeof bs.offsetX === 'number' &&
          typeof bs.offsetY === 'number' &&
          typeof bs.blur === 'number' &&
          typeof bs.spread === 'number' &&
          typeof bs.color === 'string'
        ) {
          out.boxShadow = {
            offsetX: bs.offsetX,
            offsetY: bs.offsetY,
            blur: Math.max(0, Math.min(80, bs.blur)),
            spread: bs.spread,
            color: bs.color,
          };
        }
      }
    }

    return out;
  }
}
