import { clientAsksForSplit } from '../domain/scene-director-composition';

export interface ScenePromptInput {
  /** Pedido literal do cliente, em português. */
  request: string;
  /**
   * Itens do que o cliente pediu ainda em aberto. Só a imagem nova passa isto: a primeira imagem da cena nunca,
   * porque o prompt julgado excelente pelo dono (D-38) não pode mudar.
   */
  openItems?: string[];
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  /** Formato da cena e mensagens do cliente: decidem a frase de continuidade (D-43). */
  formatId?: string;
  clientMessages?: string[];
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

/** D-16: a composição só entra se o cliente pedir; o resto é uma imagem única e contínua. */
export const CONTINUOUS_IMAGE_RULE =
  'Salvo se o pedido acima disser outra coisa, a imagem é única e contínua, sem divisões, faixas ou molduras.';

/** D-43: só o formato alto, onde a emenda apareceu (3 de 7 sem a frase, 0 de 6 com ela). Texto literal do dono. */
export const CONTINUITY_PHRASE =
  'A cena é um único ambiente contínuo do topo à base: um só horizonte, um só chão, e nenhum objeto ou grupo apoiado em ilha, faixa ou pedaço de terreno separado.';

/** Formatos que levam a frase de continuidade. `folheto-27x40` fica de fora (ponto de atenção da passada 3.3). */
export const CONTINUITY_FORMAT_IDS: readonly string[] = ['folheto-27x54'];

/** O prompt de imagem traz a frase? No formato alto, e não quando o cliente pede moldura, faixa ou divisão. */
export function continuityApplies(
  formatId: string | undefined,
  clientMessages: string[] = [],
): boolean {
  return (
    formatId !== undefined &&
    CONTINUITY_FORMAT_IDS.includes(formatId) &&
    !clientAsksForSplit(clientMessages)
  );
}

/** Regra de texto em TODOS os casos: texto pintado é recusado antes, então não há exceção (R32 saiu). */
export const NO_TEXT_RULES =
  'Regras: sem texto legível, sem letras ou números, sem logotipos e sem preços.';

export const FIXED_RULES =
  'Regras: sem texto legível, sem letras ou números, sem logotipos, sem preços, sem produtos de marcas reais e sem pessoas identificáveis.';

/** Os itens em aberto, numa frase fixa do código (nunca texto livre do modelo). */
export function openItemsSentence(items: string[]): string {
  return ` Pedidos do cliente ainda em aberto: ${items.map((item) => cleanRequest(item).replace(/[.!]+$/, '')).join('; ')}.`;
}

/**
 * Prompt da geração (primeira, e imagem nova da D-18): o pedido literal, o formato em cm e a
 * proporção, a imagem única e contínua (D-16) e as regras fixas. Sem composição por faixas ou zonas.
 */
export function buildGeneratePrompt(input: ScenePromptInput): string {
  const ratio = (input.artWidthCm / input.artHeightCm).toFixed(2).replace('.', ',');
  return [
    'Crie a imagem de fundo de um encarte de ofertas de supermercado, para impressão.',
    `Pedido do cliente: "${cleanRequest(input.request)}".`,
    ...(input.openItems?.length ? [openItemsSentence(input.openItems).trim()] : []),
    `Formato: ${cm(input.artWidthCm)} x ${cm(input.artHeightCm)} cm (proporção largura/altura ${ratio}), imagem de ${input.widthPx} x ${input.heightPx} px, ocupando toda a área.`,
    CONTINUOUS_IMAGE_RULE,
    ...(continuityApplies(input.formatId, input.clientMessages) ? [CONTINUITY_PHRASE] : []),
    FIXED_RULES,
  ].join('\n');
}

/** Prompt do ajuste geral: a imagem atual entra como referência; sem composição por faixas (D-16). */
export function buildGlobalPrompt(input: {
  request: string;
  /** Só a composição leva a frase de continuidade (D-43), e só no formato alto. */
  continuity?: boolean;
}): string {
  return [
    `Ajuste esta imagem de fundo de encarte conforme o pedido do cliente: "${cleanRequest(input.request)}".`,
    CONTINUOUS_IMAGE_RULE,
    ...(input.continuity ? [CONTINUITY_PHRASE] : []),
    NO_TEXT_RULES,
  ].join('\n');
}

/** Campos curtos do plano do Diretor que entram no prompt; o Diretor nunca escreve o prompt (G2). */
export interface PromptPlanFields {
  what_to_change?: string;
  what_to_put?: string;
  inventory_keep?: string[];
}

/** `instr`: o que muda e o que fica no lugar, sem pontuação final. */
export function planInstruction(plan: PromptPlanFields): string {
  const parts = [plan.what_to_change, plan.what_to_put]
    .map((part) => cleanRequest(part ?? '').replace(/[.!;]+$/, ''))
    .filter(Boolean);
  return parts.join('; ');
}

/** `mant`: o que precisa continuar como está, ou vazio. */
export function planKeepSentence(plan: PromptPlanFields): string {
  const names = (plan.inventory_keep ?? []).map((name) => cleanRequest(name)).filter(Boolean);
  return names.length ? ` Mantenha como estão: ${names.join(', ')}.` : '';
}

/** O pedido do plano para o gerador: `instr`, ponto e `mant`. */
export function planRequest(plan: PromptPlanFields): string {
  return `${planInstruction(plan)}.${planKeepSentence(plan)}`;
}

const KEEP_ALL =
  'Preserve todo o resto da imagem exatamente como está, sem mudar estilo, cor ou composição';

export type RedrawKind = 'global' | 'composition' | 'item' | 'marked';

/**
 * Prompt do redesenho da imagem inteira, sempre montado pelo código a partir dos campos do plano:
 * - `global` (ajuste geral) e `composition` (reorganizar): `buildGlobalPrompt` com o plano e "Mantenha como estão";
 *   só a composição leva a frase de continuidade, e só no formato alto (D-43);
 * - `item` (por texto): "Nesta imagem: ... Altere somente isso. Preserve...";
 * - `marked` (com marcação): "Dentro do retângulo da camada de marcação: ... O retângulo é só uma marcação...".
 * Os itens em aberto entram logo depois de `mant`. "Preserve..." é instrução ao modelo, não promessa ao cliente.
 */
export function buildRedrawPrompt(input: {
  kind: RedrawKind;
  plan: PromptPlanFields;
  openItems?: string[];
  formatId?: string;
  clientMessages?: string[];
}): string {
  const { kind, plan } = input;
  const open = input.openItems?.length ? openItemsSentence(input.openItems) : '';
  const body = `${planInstruction(plan)}.${planKeepSentence(plan)}${open}`;
  if (kind === 'global' || kind === 'composition') {
    return buildGlobalPrompt({
      request: body,
      continuity: kind === 'composition' && continuityApplies(input.formatId, input.clientMessages),
    });
  }
  if (kind === 'marked') {
    return `Dentro do retângulo da camada de marcação: ${body} Altere somente essa área. ${KEEP_ALL} fora dela. O retângulo é só uma marcação: não deixe o retângulo no resultado. ${NO_TEXT_RULES}`;
  }
  return `Nesta imagem: ${body} Altere somente isso. ${KEEP_ALL}. ${NO_TEXT_RULES}`;
}
