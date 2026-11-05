import { SceneZones } from '../domain/scene.types';

export interface ScenePromptInput {
  /** Pedido literal do cliente, em português. */
  request: string;
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  zones: SceneZones;
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;
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
 * Prompt da primeira geração: o pedido literal, o formato em cm e a proporção, a composição por
 * faixas e as regras fixas (sem texto legível, sem logotipos, sem preços). Composição (aprovada em
 * 2026-11-05, depois da passada real do estágio 3): os elementos da cena ficam nas faixas do
 * cabeçalho e do rodapé, com as alturas do formato, e o miolo fica calmo e sem objetos, porque os
 * cards de produtos e preços entram por cima dele.
 */
export function buildGeneratePrompt(input: ScenePromptInput): string {
  const { zones } = input;
  const ratio = (input.artWidthCm / input.artHeightCm).toFixed(2).replace('.', ',');
  return [
    'Crie a imagem de fundo de um encarte de ofertas de supermercado, para impressão.',
    `Pedido do cliente: "${cleanRequest(input.request)}".`,
    `Formato: ${cm(input.artWidthCm)} x ${cm(input.artHeightCm)} cm (proporção largura/altura ${ratio}), imagem de ${input.widthPx} x ${input.heightPx} px, ocupando toda a área, sem bordas nem molduras.`,
    'Composição, de cima para baixo:',
    `- cabeçalho (faixa superior de ${percent(zones.header.h)} da altura): aqui ficam os elementos da cena (por exemplo o sol, as nuvens e a decoração do tema), inteiros e dentro da faixa;`,
    `- miolo (${percent(zones.body.h)} da altura): fundo calmo e suave, SEM objetos nem personagens, porque os cards de produtos e preços ficam por cima dele;`,
    `- rodapé (faixa inferior de ${percent(zones.footer.h)} da altura): aqui também ficam elementos da cena, inteiros e dentro da faixa.`,
    'Nenhum elemento da cena pode invadir o miolo.',
    'Regras: sem texto legível, sem letras ou números, sem logotipos, sem preços, sem produtos de marcas reais e sem pessoas identificáveis.',
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

/** Prompt do ajuste geral: a imagem atual entra como referência e a composição é mantida. */
export function buildGlobalPrompt(input: { request: string; zones: SceneZones }): string {
  const { zones } = input;
  return [
    `Ajuste esta imagem de fundo de encarte conforme o pedido do cliente: "${cleanRequest(input.request)}".`,
    `Mantenha a composição: cabeçalho de ${percent(zones.header.h)}, miolo de ${percent(zones.body.h)} (calmo, sem objetos) e rodapé de ${percent(zones.footer.h)}, com os elementos nos mesmos lugares.`,
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
