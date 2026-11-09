/** As fichas reais do estudo pago da change add-template-scene-from-reference (rodada 2), como a visão as devolveu. */

export const FICHA_R1: Record<string, unknown> = {
  theme: 'Brazilian June festival with a lively, colorful, celebratory mood.',
  signature_elements: [
    {
      element: 'Blue checker fabric pattern',
      kind: 'decoration',
      where: 'top edge',
      notes: 'Saturated cobalt and royal blue checks with a crisp, festive look.',
    },
    {
      element: 'Triangular paper bunting',
      kind: 'decoration',
      where: 'header',
      notes: 'Small vivid pennants in red, yellow, green, and blue, strung along the upper area.',
    },
    {
      element: 'Hanging braided cords',
      kind: 'decoration',
      where: 'header',
      notes: 'Short orange and gold strands with a playful handmade feel.',
    },
    {
      element: 'Geometric color rays',
      kind: 'decoration',
      where: 'corners',
      notes: 'Angular red, yellow, and green accents radiating inward from the upper corners.',
    },
  ],
  background_texture:
    'Blue checker fabric across the upper area, transitioning to a soft, light neutral field below.',
  palette: [
    {
      hex: '#1739D2',
      role: 'upper checker pattern',
    },
    {
      hex: '#F2C943',
      role: 'bunting and warm accents',
    },
    {
      hex: '#E94036',
      role: 'festive edge accents',
    },
    {
      hex: '#32A84A',
      role: 'bunting accents',
    },
    {
      hex: '#FFF4D6',
      role: 'body background',
    },
  ],
  header: {
    shape: 'straight',
    height_pct: 17,
    fill: 'Blue checker texture with colorful triangular bunting, braided hanging cords, and restrained geometric accents.',
  },
  body_suggestion:
    'Keep the body open and uncluttered with a warm ivory tint and a barely visible soft gradient; reserve the stronger pattern and decorations for the upper edge.',
  ignored_sections: [
    'Product section panels',
    'Colored section blocks',
    'Day and weekday columns',
    'Section title bars',
    'Product grids',
    'Cards',
    'Dividers between product groups',
    'Produce-section awning',
    'Meat-section flames',
    'Fruit-section grass or wood-plank decoration',
  ],
  ignored_content: [
    'Logos',
    'Store names',
    'Brands',
    'Product imagery',
    'Prices',
    'Texts',
    'Dates',
    'People',
    'Mascots',
    'QR codes',
    'Payment logos',
    'Social icons',
  ],
};

export const FICHA_R2: Record<string, unknown> = {
  theme:
    'A lively Brazilian supermarket savings campaign with a bold, high-energy promotional mood.',
  signature_elements: [
    {
      element: 'Deep blue geometric rays with halftone dots',
      kind: 'decoration',
      where: 'whole background',
      notes: 'Vivid cobalt and cyan, angled and energetic, with a subtle darker blue vignette.',
    },
    {
      element: 'Glossy gold coin medallions',
      kind: 'logo_or_badge',
      where: 'top edge',
      notes: 'Oversized, embossed, dimensional accents with warm highlights.',
    },
    {
      element: 'Circular shopping-cart medallion',
      kind: 'logo_or_badge',
      where: 'top edge',
      notes: 'Deep red and bronze, raised metallic rim, used as an abstract retail motif.',
    },
    {
      element: 'Small triangular paper bunting',
      kind: 'decoration',
      where: 'corners',
      notes: 'Bright cyan and blue accents, sparse and playful.',
    },
  ],
  background_texture:
    'Cobalt-to-cyan geometric rays with scattered halftone dots and a subtle soft glow.',
  palette: [
    {
      hex: '#073CB8',
      role: 'main background field',
    },
    {
      hex: '#0879ED',
      role: 'ray accents',
    },
    {
      hex: '#21D8E8',
      role: 'bright highlights',
    },
    {
      hex: '#F6D923',
      role: 'golden accents',
    },
    {
      hex: '#C93624',
      role: 'warm medallion accents',
    },
    {
      hex: '#F5F2E9',
      role: 'calm body background',
    },
  ],
  header: {
    shape: 'Straight lower edge with layered diagonal ray accents',
    height_pct: 22,
    fill: 'Abstract cobalt and cyan rays, subtle halftone dots, and a few glossy gold medallion accents.',
  },
  body_suggestion:
    'Keep the body spacious and mostly empty with a warm off-white tint, a very faint blue glow near the edges, and barely visible halftone dots.',
  ignored_sections: [
    'Product section panels and colored section blocks',
    'Day and weekday columns',
    'Section title bars',
    'Product grids and cards',
    'Dividers between product groups',
    'Any decoration belonging to a single section, including section-specific awnings, flames, grass, or wood planks',
  ],
  ignored_content: [
    'Logos',
    'Store names',
    'Brands',
    'Product imagery',
    'Prices',
    'Texts',
    'Dates',
    'People',
    'Mascots',
    'QR codes',
    'Payment logos',
    'Social icons',
  ],
};

export const FICHA_NAVARRO: Record<string, unknown> = {
  theme: 'An October retail-sale concept with energetic, warm, celebratory styling.',
  signature_elements: [
    {
      element: 'Large circular medallion with an abstract shopping-cart symbol',
      kind: 'logo_or_badge',
      where: 'top right',
      notes: 'Layered burgundy, red, and golden-orange rings with glossy dimensional shading.',
    },
    {
      element: 'Warm blurred color forms and soft bokeh',
      kind: 'decoration',
      where: 'header',
      notes: 'Vivid but softly defocused, with golden highlights and hints of green.',
    },
    {
      element: 'Narrow warm-toned horizontal accent',
      kind: 'decoration',
      where: 'bottom edge',
      notes: 'Bright orange and yellow glow, kept subtle and continuous.',
    },
  ],
  background_texture: 'Softly blurred warm retail-inspired color field with gentle bokeh.',
  palette: [
    {
      hex: '#7A2028',
      role: 'medallion and deep accents',
    },
    {
      hex: '#D94335',
      role: 'warm accent',
    },
    {
      hex: '#F2A12A',
      role: 'golden highlights',
    },
    {
      hex: '#FFE45A',
      role: 'bright accent',
    },
    {
      hex: '#F7F1E6',
      role: 'body background',
    },
    {
      hex: '#66834A',
      role: 'muted background accents',
    },
  ],
  header: {
    shape: 'straight horizontal edge',
    height_pct: 27,
    fill: 'Warm blurred color field with golden bokeh and a layered burgundy-and-gold circular medallion near the right side.',
  },
  body_suggestion:
    'Keep the body open and calm with a warm off-white tint, a very soft gradient, and minimal low-contrast texture.',
  ignored_sections: [
    'Product section panels',
    'Colored section blocks',
    'Day or weekday columns',
    'Section title bars',
    'Product grids',
    'Cards',
    'Dividers between product groups',
    'Decoration belonging to one section only',
  ],
  ignored_content: [
    'Logos',
    'Store names',
    'Brands',
    'Product imagery',
    'Prices',
    'Texts',
    'Dates',
    'People',
    'Mascots',
    'QR codes',
    'Payment logos',
    'Social icons',
  ],
};
