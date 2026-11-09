/**
 * A ficha-conceito que o `MockSceneVisionClient` devolve (change add-template-scene-from-reference): a do R1 do estudo
 * (festa junina) com os rótulos em pt-BR e um medalhão de carrinho a mais, para exercitar o sanitizador (D-1).
 */

/** Marcadores no pedido de correção que simulam as falhas da leitura. */
export const MOCK_REFERENCE_MARKERS = {
  /** A visão fica fora do ar. */
  fail: '#ficha-falha',
  /** A saída não é JSON. */
  invalid: '#ficha-invalida',
  /** A visão diz que a imagem não é um encarte. */
  notFlyer: '#nao-e-encarte',
} as const;

/** O prompt da ficha começa assim (`buildConceptPrompt`). */
export const CONCEPT_PROMPT_START = 'You are an art director analysing a retail flyer';

const BUNTING = {
  element: 'Triangular paper bunting',
  label_pt: 'bandeirinhas de São João',
  kind: 'decoration',
  where: 'header',
  notes: 'Small vivid pennants in red, yellow, green, and blue, strung along the upper area.',
};

const ELEMENTS = [
  {
    element: 'Blue checker fabric pattern',
    label_pt: 'tecido xadrez azul',
    kind: 'decoration',
    where: 'top edge',
    notes: 'Saturated cobalt and royal blue checks with a crisp, festive look.',
  },
  BUNTING,
  {
    element: 'Hanging braided cords',
    label_pt: 'cordões trançados',
    kind: 'decoration',
    where: 'header',
    notes: 'Short orange and gold strands with a playful handmade feel.',
  },
  {
    element: 'Geometric color rays',
    label_pt: 'raios de cor',
    kind: 'decoration',
    where: 'corners',
    notes: 'Angular red, yellow, and green accents radiating inward from the upper corners.',
  },
  {
    element: 'Circular shopping-cart medallion',
    label_pt: 'medalhão com carrinho',
    kind: 'logo_or_badge',
    where: 'top right',
    notes: 'Deep red and bronze, raised metallic rim.',
  },
];

const PALETTE = [
  { hex: '#1739D2', name_pt: 'azul cobalto', role: 'header, upper checker pattern' },
  { hex: '#F2C943', name_pt: 'amarelo', role: 'bunting and warm accents' },
  { hex: '#E94036', name_pt: 'vermelho', role: 'festive edge accents' },
  { hex: '#32A84A', name_pt: 'verde', role: 'bunting accents' },
  { hex: '#FFF4D6', name_pt: 'marfim', role: 'body background' },
];

/** O pedido de correção do cliente (só o texto entre aspas; a ficha anterior vai no mesmo prompt). */
const noteOf = (prompt: string): string =>
  /apply it to the concept: "([^"]*)"/.exec(prompt)?.[1] ?? '';

/** A correção pede para tirar as bandeirinhas ("tira", "sem", "remove" ou "não tem" com "bandeirinha"). */
const dropsBunting = (prompt: string): boolean => {
  const note = noteOf(prompt);
  return (
    /bandeirinha/i.test(note) &&
    /(?<![\p{L}])(tira|tirar|sem|remove|remover|não tem)(?![\p{L}])/iu.test(note)
  );
};

/** A ficha crua como a visão a devolveria; com `notFlyer`, só a recusa. */
export function mockReferenceConcept(prompt: string): Record<string, unknown> {
  if (prompt.includes(MOCK_REFERENCE_MARKERS.notFlyer)) return { is_retail_flyer: false };
  return {
    is_retail_flyer: true,
    theme: 'Brazilian June festival with a lively, colorful, celebratory mood.',
    theme_pt: 'festa junina',
    signature_elements: dropsBunting(prompt)
      ? ELEMENTS.filter((item) => item !== BUNTING)
      : ELEMENTS,
    background_texture: 'Blue checker fabric across the upper area, soft light field below.',
    background_texture_pt: 'xadrez azul no alto e fundo claro embaixo',
    palette: PALETTE,
    header: {
      shape: 'straight',
      height_pct: 17,
      fill: 'Blue checker texture with colorful triangular bunting and braided hanging cords.',
    },
    body_suggestion:
      'Keep the body open with a warm ivory tint and a barely visible soft gradient.',
    ignored_sections: ['Product section panels', 'Colored section blocks', 'Product grids'],
    ignored_content: ['Logos', 'Store names', 'Prices', 'Texts', 'People', 'QR codes'],
  };
}
