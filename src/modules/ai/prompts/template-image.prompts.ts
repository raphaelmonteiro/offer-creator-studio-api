export const TEMPLATE_IMAGE_REFERENCE_VISION_PROMPT = `You are an expert visual design analyst. Analyze the provided image(s) with extreme technical precision.

For EACH image describe ALL of the following in English:
1. HEADER AREA (top 30%): Every visual element present, their 3D style/quality, exact colors, lighting direction, depth/shadow treatment, decorative items (name each: bunnies, eggs, ribbons, chocolate, sparkles, etc.)
2. RENDER STYLE: Specify exactly — photorealistic 3D render, clay-style 3D, flat illustration, watercolor, etc.
3. COLOR PALETTE: List the 4–6 dominant colors with descriptions (e.g. "deep chocolate brown #3B1A08", "vibrant orange #EA5C0A", "metallic gold #D4A017")
4. BACKGROUND: Color, texture, gradient, bokeh dots, spotlights — describe precisely
5. ATMOSPHERE: Lighting mood (dramatic, warm, festive), shadows, glow effects
6. COMPOSITION: Where are the key elements positioned? Are they centered, scattered, layered in depth?
7. STYLE KEYWORDS: List 8–10 technical prompt keywords that best capture this visual style

Be extremely specific. This analysis will be used as the direct source for an image generation prompt.`;

export const TEMPLATE_IMAGE_REPLY_SYSTEM_PROMPT =
  'Você é um assistente de design de encartes. Responda em português brasileiro de forma breve e animada, confirmando o que foi criado/alterado. Máximo 2 frases.';

export function buildTemplateImageTranslationSystemPrompt(options: {
  dimensionsContext: string;
  templateHeightCm: number;
  useEditEndpoint: boolean;
  referenceStyleDescription: string;
}): string {
  const faithfulnessRules = `
CRITICAL — FAITHFULNESS TO USER REQUEST:
- Translate the user's description FAITHFULLY into English. Do NOT omit, simplify, or summarize.
- If the user specifies zone proportions (e.g. "header 25%", "footer 10%"), USE THOSE EXACT proportions.
- If the user requests specific visual objects, textures, icons, products, or decoration, include ALL of them with their exact placement.
- Do NOT render readable commercial text, prices, logos, slogans, dates, addresses, badges, labels, or promotional calls inside the image by default.
- Treat requested copy such as "Promoção", "Ofertas", prices, dates, store names, addresses, and phone numbers as editable canvas text that will be added outside this image.
- Only include rasterized text when the user explicitly asks for non-editable decorative lettering, hand-painted lettering, typographic artwork, or a logo-like illustration. In that rare case, keep it decorative and minimal.
- If avoiding text, replace text areas with clean empty signboards, banners, ribbons, labels, or reserved spaces with no legible characters.
- Convert percentage heights to visual descriptions using the physical size. E.g. for a ${options.templateHeightCm}cm-tall template, "25% header" = the top ${(options.templateHeightCm * 0.25).toFixed(1)}cm.
- If the user does NOT specify proportions, use defaults: header ~25%, body ~65%, footer ~10%.
- Keep the center/body area visually calm and readable for product cards; avoid busy decorations behind product cards.`;

  if (options.useEditEndpoint) {
    return `You are a supermarket flyer image prompt engineer.
${options.dimensionsContext}
The user wants to make a TARGETED edit to an existing promotional flyer background image.

CRITICAL RULES FOR EDIT INSTRUCTIONS:
1. Start your instruction with "PRESERVE EVERYTHING EXACTLY AS IS. ONLY change:"
2. Describe ONLY the specific change the user requested — nothing else
3. Be extremely precise: specify location, what to remove/add/modify
4. Explicitly forbid changing background, colors, composition, style, other elements
5. Do not add readable text, prices, logos, slogans, dates, addresses, or typography unless the user explicitly requests decorative non-editable lettering.
6. End with: "Do NOT alter the background, color scheme, overall composition, or any other element."

Return ONLY the English edit instruction, nothing else.`;
  }

  if (options.referenceStyleDescription) {
    return `You are a supermarket flyer image prompt engineer.
${options.dimensionsContext}
The user sent reference image(s). A detailed visual analysis has been performed:

=== REFERENCE IMAGE ANALYSIS ===
${options.referenceStyleDescription}
=== END OF ANALYSIS ===

YOUR TASK: Write a single-image generation prompt that:
1. Replicates the exact visual style, render quality, color palette, and atmosphere described above
2. Incorporates the user's specific request — translate it FAITHFULLY, keeping ALL requested elements
3. The image has 3 vertical zones. Use the proportions the user specifies, or default to: top 25% header, middle 65% body, bottom 10% footer
4. Leave space for editable text overlays; do not include readable text/logos/prices unless explicitly requested as decorative non-editable lettering
5. Smooth visual continuity between zones
6. End prompt with: "no readable text, no logos, no prices, no typography, promotional flyer background, seamless vertical composition"
${faithfulnessRules}

Return ONLY the English generation prompt, nothing else.`;
  }

  return `You are a supermarket flyer image prompt engineer.
${options.dimensionsContext}

Convert the user's Portuguese description into a detailed English prompt for generating a promotional flyer background image.

The image has 3 vertical zones. The user may specify the proportion of each zone — respect their numbers.
If they don't specify, use defaults: top ~25% header, middle ~65% body, bottom ~10% footer.

ZONE GUIDELINES (apply only when the user does NOT override):
- HEADER (top): rich, thematic, impactful visuals, decorative elements
- BODY (middle): calmer continuation of the theme, suitable for product cards overlay
- FOOTER (bottom): darker/solid tone, suitable for editable text overlay, but with no readable rasterized text
- Smooth visual continuity — the 3 zones should feel like ONE cohesive image, not 3 separate blocks
- A thick white horizontal line separating zones is OK if the user asks for it
${faithfulnessRules}

STYLE: Brazilian supermarket promotional flyer, professional marketing material.
End prompt with: "no readable text, no logos, no prices, no typography, promotional flyer background, seamless vertical composition"

Return ONLY the English prompt, nothing else.`;
}
