export interface ScenePromptInput {
  /** Pedido literal do cliente, em português. */
  request: string;
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
}

const cm = (value: number): string => String(value).replace('.', ',');

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
};

/** Tira caracteres de controle e espaços repetidos do pedido (o texto continua literal). */
function cleanRequest(request: string): string {
  return [...request]
    .map((char) => (isControl(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * D-17: sugestão de menos detalhe no centro. Desligada até o dono ver as imagens com e sem ela (task
 * 1.37); ligar é trocar esta constante (ou passar `lessDetailAtCenter` no teste real).
 */
export const SUGGEST_LESS_DETAIL_AT_CENTER = false;

export const LESS_DETAIL_AT_CENTER_HINT =
  'Se o pedido não disser outra coisa, deixe a parte central da imagem com menos detalhe, sem criar divisão nem faixa.';

/** D-16: a composição só entra se o cliente pedir; o resto é uma imagem única e contínua. */
export const CONTINUOUS_IMAGE_RULE =
  'Salvo se o pedido acima disser outra coisa, a imagem é única e contínua, sem divisões, faixas ou molduras.';

export const FIXED_RULES =
  'Regras: sem texto legível, sem letras ou números, sem logotipos, sem preços, sem produtos de marcas reais e sem pessoas identificáveis.';

/**
 * Prompt da geração (primeira, e imagem nova da D-18): o pedido literal, o formato em cm e a
 * proporção, a imagem única e contínua (D-16) e as regras fixas. Sem composição por faixas ou zonas.
 */
export function buildGeneratePrompt(
  input: ScenePromptInput,
  options: { lessDetailAtCenter?: boolean } = {},
): string {
  const ratio = (input.artWidthCm / input.artHeightCm).toFixed(2).replace('.', ',');
  const lessDetail = options.lessDetailAtCenter ?? SUGGEST_LESS_DETAIL_AT_CENTER;
  return [
    'Crie a imagem de fundo de um encarte de ofertas de supermercado, para impressão.',
    `Pedido do cliente: "${cleanRequest(input.request)}".`,
    `Formato: ${cm(input.artWidthCm)} x ${cm(input.artHeightCm)} cm (proporção largura/altura ${ratio}), imagem de ${input.widthPx} x ${input.heightPx} px, ocupando toda a área, sem bordas nem molduras.`,
    CONTINUOUS_IMAGE_RULE,
    ...(lessDetail ? [LESS_DETAIL_AT_CENTER_HINT] : []),
    FIXED_RULES,
  ].join('\n');
}

const KEEP_REST =
  'Preserve todo o resto da imagem exatamente como está, sem mudar estilo, cor ou composição fora da região.';

export const REMOVE_INSTRUCTION = 'remova o que está na área marcada e continue o fundo ao redor';

/**
 * Prompt da edição local: a instrução literal do cliente em português, precedida de "Na área
 * marcada" (com o nome dos elementos conhecidos na região, se houver) e das frases de preservação
 * medidas no spike. `remove` troca a instrução pela remoção com continuação do fundo.
 */
export function buildEditPrompt(input: {
  request: string;
  remove: boolean;
  knownElements: string[];
}): string {
  const names = input.knownElements.length > 0 ? ` (${input.knownElements.join(', ')})` : '';
  const instruction = input.remove ? REMOVE_INSTRUCTION : cleanRequest(input.request);
  return `Na área marcada${names}: ${instruction}. Altere somente a área indicada pela máscara. ${KEEP_REST}`;
}

/** Prompt do ajuste geral: a imagem atual entra como referência; sem composição por faixas (D-16). */
export function buildGlobalPrompt(input: { request: string }): string {
  return [
    `Ajuste esta imagem de fundo de encarte conforme o pedido do cliente: "${cleanRequest(input.request)}".`,
    CONTINUOUS_IMAGE_RULE,
    'Regras: sem texto legível, sem letras ou números, sem logotipos e sem preços.',
  ].join('\n');
}

/** Prompt do "adicionar": o item isolado, com fundo transparente. */
export function buildTransparentPrompt(subject: string): string {
  return [
    `Crie ${cleanRequest(subject)} como um objeto isolado, centralizado, com fundo totalmente transparente.`,
    'Estilo de ilustração limpa para encarte de supermercado, sem sombra projetada no fundo.',
    'Regras: sem texto legível, sem letras ou números, sem logotipos e sem preços.',
  ].join('\n');
}
