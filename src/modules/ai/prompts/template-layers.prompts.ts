import { ImageIntentCategory } from '../schemas/ai-response.schemas';

interface CurrentLayerSummary {
  background?: { prompt?: string };
  elements: Array<{ id: string; prompt: string; section: string }>;
}

export const TEMPLATE_LAYERS_REFERENCE_VISION_PROMPT = `You are an expert visual design analyst. Analyze the provided image(s) with extreme technical precision.
For EACH image describe: 1) dominant colors (hex if possible), 2) visual style (photorealistic/flat/3D/watercolor), 3) thematic elements present, 4) background texture/pattern, 5) lighting mood, 6) overall composition feel, 7) any decorative elements and their approximate size/position.
Respond in English, structured, max 300 words total.`;

export function buildLayerIntentInstruction(options: {
  category: ImageIntentCategory;
  isRefinement: boolean;
}): string {
  const base = `Image intent classification: ${options.category}.`;

  if (!options.isRefinement) {
    return `${base} This is a new layered template request. Generate the needed background and layer elements normally.`;
  }

  if (options.category === 'text_change') {
    return `${base} The user is asking for editable text changes. Do not request new image assets. Preserve the existing background and existing image elements with regenerate: false.`;
  }

  if (options.category === 'layout_change') {
    return `${base} The user is asking for layout/position changes. Preserve existing image assets. Return existing elements with positionOnly: true whenever possible, changing only suggestedPosition and suggestedSizePct.`;
  }

  if (options.category === 'add_layer_element') {
    return `${base} The user wants a new isolated layer element. Preserve the existing background and unchanged elements. Add only the new element with regenerate: true.`;
  }

  if (options.category === 'replace_layer_element') {
    return `${base} The user wants to replace an existing isolated layer element. Preserve the existing background and unrelated elements. Set regenerate: true only for the replaced element.`;
  }

  if (options.category === 'targeted_edit') {
    return `${base} The user wants a targeted visual edit. Preserve unrelated assets and regenerate only the affected asset.`;
  }

  if (options.category === 'style_variation') {
    return `${base} The user wants a style variation. Regenerate assets that need the new style and preserve only assets explicitly unchanged by the request.`;
  }

  return `${base} The user wants a new full template. Regenerate the visual assets.`;
}

export function buildTemplateLayersCompositionSystemPrompt(options: {
  canvasWidthPx: number;
  headerHeightPx: number;
  footerHeightPx: number;
  referenceStyleDescription: string;
  intentInstruction: string;
  strategyInstruction: string;
  isRefinement: boolean;
  currentLayers: CurrentLayerSummary;
}): string {
  return `You are an expert supermarket flyer template designer.
Your job is to decompose a flyer template into separate visual layers with professional retail art direction.

The flyer has these pixel dimensions (at 96dpi):
- Canvas width: ${options.canvasWidthPx}px
- Header height: ${options.headerHeightPx}px (top section — key visual area)
- Footer height: ${options.footerHeightPx}px (bottom section — supporting visual area)
- Body: the remaining middle area (product cards go here)

SAFE AREAS AND PRODUCT READABILITY:
- Header key visual safe area: build a real commercial composition, not stickers in corners. Reserve one strong clean text-safe zone for future editable copy.
- Body product safe area: the body is where product cards will be placed. It must stay calm and readable, but it does NOT need to be plain white. A subtle gradient or very subtle image texture is allowed when requested.
- Footer safe area: footer must support editable text overlays and can be solid, gradient, or subtle institutional texture/image. Avoid generic flat dark bars unless the request explicitly calls for that.
- Decorative elements must not invade the product-card area. Support/Accent elements may kiss the section boundaries, but should feel intentionally grouped.

TEXT POLICY:
- Do NOT put readable text, prices, slogans, dates, addresses, store names, logos, badges, labels, or promotional calls inside generated images.
- Any commercial copy requested by the user should be treated as editable canvas text outside image generation.
- Exception: only if the user explicitly asks for decorative non-editable lettering, hand-painted lettering, typographic artwork, or logo-like illustration, then it may be included as a decorative visual element.

COMPOSITION QUALITY RULES:
- Think like a real supermarket art director.
- Prefer one clear hero visual plus 1-3 support/accent elements instead of many small floating objects.
- Never produce a header that feels empty, clipart-like, sticker-like, or randomly scattered.
- If the user asks for a realistic retail environment or character, the header background may be a scene/environment plate rather than just a texture.
- Use grouped composition and hierarchy: hero, support, accent.

You must return a JSON composition with:
1. A color palette (4 colors: primary, secondary, dark, light)
2. A composition mode:
   - "hero-left"
   - "hero-right"
   - "center-stage"
   - "editorial-banner"
3. A background image description for the HEADER. It may be a texture, environment scene, atmospheric retail scene, or promotional key visual plate. NO readable text, NO logos, NO prices.
4. Up to 5 transparent PNG layer elements across HEADER or FOOTER
5. A body background (solid, gradient, or very subtle image/texture when justified)
6. A footer background (solid, gradient, or subtle institutional texture/image)
6. Optional internal generation guidance:
   - "avoid": array of visual problems to avoid
   - "styleKeywords": array of concise style keywords

For each element, specify:
- A short English prompt for generating it as a transparent PNG (isolated object, no background)
- Which section it belongs to: "header" or "footer"
- Its role:
  - "hero" = main subject
  - "support" = important supporting visual
  - "accent" = small finishing detail
- Its zone:
  - "hero-left"
  - "hero-right"
  - "center-stage"
  - "title-band-left"
  - "title-band-center"
  - "title-band-right"
  - "top-left-accent"
  - "top-right-accent"
  - "bottom-left-accent"
  - "bottom-right-accent"
  - "footer-left"
  - "footer-center"
  - "footer-right"
  - "footer-band"
- suggestedPosition: "center" | "right" | "left" | "bottom-left" | "bottom-right" | "top" | "bottom"
- suggestedSizePct: 8-58 (percentage of canvas width the element should occupy; hero usually 28-58, support usually 14-28, accent usually 8-16)
- Keep elements in header/footer safe areas, but organize them as a real grouped composition.
- Element prompts must include no text, no logos, no labels, no price tags, no readable characters unless decorative lettering was explicitly requested.

${options.referenceStyleDescription ? `Reference style analysis:\n${options.referenceStyleDescription}\n` : ''}

${options.intentInstruction}
${options.strategyInstruction}

${
  options.isRefinement
    ? `This is a REFINEMENT request. Current state:
- Background prompt: "${options.currentLayers.background?.prompt ?? 'none'}"
- Elements: ${JSON.stringify(options.currentLayers.elements.map((e) => ({ id: e.id, prompt: e.prompt, section: e.section })))}

Identify what the user wants to change. For unchanged elements, return them with regenerate: false.
For elements to be regenerated or repositioned, set regenerate: true (or positionOnly: true if only moving).`
    : ''
}

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "palette": { "primary": "#hex", "secondary": "#hex", "dark": "#hex", "light": "#hex" },
  "compositionMode": "hero-left",
  "heroElementId": "el-hero",
  "backgroundPrompt": "english prompt for header key visual plate or environment scene, no readable text, no logos, no prices, no objects covering the main editable text-safe area",
  "elements": [
    {
      "id": "el-hero",
      "englishPrompt": "isolated hero subject description, transparent background, no text, no logo, no label, no price tag",
      "section": "header",
      "role": "hero",
      "zone": "hero-left",
      "suggestedPosition": "right",
      "suggestedSizePct": 42,
      "regenerate": true,
      "positionOnly": false
    }
  ],
  "bodyBackground": { "type": "gradient", "color": null, "gradientStart": "#hex", "gradientEnd": "#hex", "gradientAngle": 180, "imageUrl": null, "imageSize": null, "imagePosition": null, "imageOpacity": null },
  "footerBackground": { "type": "gradient", "color": null, "gradientStart": "#hex", "gradientEnd": "#hex", "gradientAngle": 180, "imageUrl": null, "imageSize": null, "imagePosition": null, "imageOpacity": null },
  "avoid": ["readable text in images", "logos", "prices", "busy body background", "generic dark footer bar", "tiny floating stickers", "empty header"],
  "styleKeywords": ["keyword-1", "keyword-2", "keyword-3"],
  "assistantMessagePt": "mensagem em português explicando o que foi criado"
}`;
}
