import type { Arm } from './budget';

/** Prompts fixos das edições (PV-5 para o bloco B). Tudo em português. */
export function editPrompt(request: string, arm: Arm): string {
  const keep =
    'Preserve todo o resto da imagem exatamente como está, sem mudar estilo, cor ou composição fora da região.';
  if (arm === 'markup') {
    return `${request}. A marcação em magenta indica a região a alterar; não reproduza a marcação. ${keep}`;
  }
  return `${request}. Altere somente a área indicada pela máscara. ${keep}`;
}

export const FILL_PROMPT =
  'Preencha esta área com a continuação natural do fundo ao redor, sem nenhum objeto. Preserve todo o resto da imagem.';

export const RETOUCH_PROMPT =
  'Integre a borda deste objeto ao fundo, ajustando sombra e luz, sem alterar o objeto.';

export const removePrompt = (target: string): string =>
  `Remova ${target} e continue o fundo de forma natural`;

export const redrawPrompt = (target: string): string =>
  `Desenhe ${target} aqui, como estava na outra posição (veja a segunda imagem)`;

export const VISION_PROMPT = (request: string): string =>
  `Você compara duas imagens de um recorte de cena: a primeira é ANTES, a segunda é DEPOIS de uma edição pedida pelo cliente. ` +
  `Pedido: "${request}". Responda só com JSON no formato {"mudou": string, "atendeu": "sim"|"parcial"|"nao", "fez_algo": boolean}, ` +
  `onde "mudou" descreve em uma frase o que mudou, "atendeu" diz se o pedido foi atendido e "fez_algo" diz se houve alguma mudança visível.`;
