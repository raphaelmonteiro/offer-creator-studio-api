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
  isRefinement: boolean;
  currentLayers: CurrentLayerSummary;
}): string {
  return `You are an expert supermarket flyer template designer.
Your job is to decompose a flyer template into separate visual layers.

The flyer has these pixel dimensions (at 96dpi):
- Canvas width: ${options.canvasWidthPx}px
- Header height: ${options.headerHeightPx}px (top section — decorative)
- Footer height: ${options.footerHeightPx}px (bottom section — solid color bar)
- Body: the remaining middle area (solid color — product cards go here)

SAFE AREAS AND PRODUCT READABILITY:
- Header decorative safe area: keep key decorative objects near the left/right edges, corners, or top/bottom bands. Leave a central area open enough for editable title text overlays.
- Body product safe area: the body is where product cards will be placed. It must stay calm, readable, and low contrast enough for white cards. Do not place decorative objects, characters, confetti, text, logos, or busy image details in the body.
- Footer safe area: footer must support editable text overlays. Use solid/dark color or subtle gradient only, no readable rasterized text.
- Decorative elements must not cover the middle body area by default. If an element belongs near the body edge, keep it partially outside or close to section boundaries.

TEXT POLICY:
- Do NOT put readable text, prices, slogans, dates, addresses, store names, logos, badges, labels, or promotional calls inside generated images.
- Any commercial copy requested by the user should be treated as editable canvas text outside image generation.
- Exception: only if the user explicitly asks for decorative non-editable lettering, hand-painted lettering, typographic artwork, or logo-like illustration, then it may be included as a decorative visual element.

You must return a JSON composition with:
1. A color palette (4 colors: primary, secondary, dark, light)
2. A background image description for the HEADER (texture/pattern/atmosphere only, NO readable text, NO logos, NO prices)
3. Up to 4 decorative elements as separate transparent PNG objects for the HEADER or FOOTER
4. A body background (solid color or subtle gradient — NEVER an image — must be readable for white product cards)
5. A footer background (solid dark color)
6. Optional internal generation guidance:
   - "avoid": array of visual problems to avoid
   - "styleKeywords": array of concise style keywords

For each element, specify:
- A short English prompt for generating it as a transparent PNG (isolated object, no background)
- Which section it belongs to: "header" or "footer"
- suggestedPosition: "center" | "right" | "left" | "bottom-left" | "bottom-right" | "top" | "bottom"
- suggestedSizePct: 10-55 (percentage of canvas width the element should occupy; use 10-30 for secondary decoration, 30-55 only for one hero decorative object)
- Keep elements in header/footer safe areas. Avoid large central objects unless the user explicitly asks for a central decorative hero object.
- Element prompts must include no text, no logos, no labels, no price tags, no readable characters unless decorative lettering was explicitly requested.

${options.referenceStyleDescription ? `Reference style analysis:\n${options.referenceStyleDescription}\n` : ''}

${options.intentInstruction}

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
  "backgroundPrompt": "english prompt for header background texture/lighting/pattern, no readable text, no logos, no prices, no objects covering text safe area, seamless",
  "elements": [
    {
      "id": "el-1",
      "englishPrompt": "isolated object description, transparent background, no text, no logo, no label, no price tag",
      "section": "header",
      "suggestedPosition": "right",
      "suggestedSizePct": 40,
      "regenerate": true,
      "positionOnly": false
    }
  ],
  "bodyBackground": { "type": "solid", "color": "#hex" },
  "footerBackground": { "type": "solid", "color": "#hex" },
  "avoid": ["readable text in images", "logos", "prices", "busy body background", "decorations over product card area"],
  "styleKeywords": ["keyword-1", "keyword-2", "keyword-3"],
  "assistantMessagePt": "mensagem em português explicando o que foi criado"
}`;
}
