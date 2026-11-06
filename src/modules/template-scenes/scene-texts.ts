import { SceneFailureCode } from './domain/scene.types';

/** Mensagens do assistente no chat da cena (pt-BR). */

export const READY_REPLY =
  'Pronto! Gerei a cena no tamanho do formato. Veja a prévia ao lado e use as camadas para o texto e o logo.';

export const CANCELLED_REPLY = 'Geração cancelada.';

/** Recusa de texto, preço e logo pintados (G3): a camada é o caminho exato. */
export const PAINTED_REFUSAL_REPLIES = {
  painted_text:
    'Não pinto texto na imagem: o modelo de imagem erra letras. Texto fica exato como camada. Me diga o texto entre aspas e onde colocar, e eu o coloco como camada. Nada foi alterado.',
  painted_price:
    'Não pinto preço na imagem: o modelo de imagem erra números. Preço fica exato como texto em camada. Me diga o texto entre aspas e onde colocar, e eu o coloco como camada. Nada foi alterado.',
  painted_logo:
    'Não pinto a logo na imagem: ela fica exata como camada. Envie a logo pelo clipe e diga onde colocar, ou mantenha a camada que já está na cena. Nada foi alterado.',
} as const;

/** Composição que o plano pediu e o cliente não (G4): vira pergunta, sem imagem. */
export const compositionQuestion = (labels: string[]): string =>
  `Você quer ${labels.join(', ')} na imagem? Não incluo isso sem você pedir. Se quiser, me diga como. Nada foi alterado.`;

/** O corte do ano, data ou número (D-42) esvaziou o pedido: vira pergunta, sem imagem. */
export const NUMBER_QUESTION =
  'Não pinto ano, data nem número na imagem: o modelo de imagem erra números. Me diga o que mudar na imagem; se quiser o número, me diga o texto entre aspas e onde colocar, e eu o coloco como camada. Nada foi alterado.';

/** Camada ou desfazer numa cena sem imagem. */
export const NO_IMAGE_REPLY =
  'Ainda não há imagem na cena. Descreva a imagem que quer gerar. Nada foi alterado.';

/** Desfazer (G5): a restauração é do código, sem chamar o modelo de imagem. */
export const FIRST_IMAGE_REPLY = 'Essa já é a primeira imagem, não há versão anterior para voltar.';

const availableText = (numbers: number[]): string =>
  numbers.length ? ` Disponíveis: ${numbers.join(', ')}.` : ' Não há versão disponível.';

export const versionRestoredReply = (source: number, created: number): string =>
  `Voltei para a imagem da versão ${source}. Ela agora é a versão ${created}.`;

export const versionIsCurrentReply = (displayNumber: number): string =>
  `A versão ${displayNumber} já é a atual. Nada foi alterado.`;

export const versionMissingReply = (requested: number, available: number[]): string =>
  `Não existe a versão ${requested}.${availableText(available)} Nada foi alterado.`;

export const versionPurgedReply = (available: number[]): string =>
  `Essa imagem não está mais disponível: guardamos só as versões mais recentes, as aprovadas e a atual.${availableText(available)} Nada foi alterado.`;

/** Aviso do redesenho (D-35): uma vez por conversa, na primeira edição, no anúncio. */
export const REDRAW_NOTICE =
  'Cada pedido redesenha a imagem inteira, então detalhes que você não pediu podem variar. Se não gostar, é só pedir para voltar.';

/** O que o juiz conferiu, em fatos; o texto ao cliente sai disto, nunca do modelo de imagem nem do Diretor. */
export interface JudgeFacts {
  satisfied: 'sim' | 'parcial' | 'nao';
  /** O que mudou, já sem promessa de preservação. */
  changed: string;
  /** Itens do que o cliente pediu que o juiz não viu na imagem nova. */
  missing: string[];
  textInImage: boolean;
  /** O juiz viu emenda ou objeto flutuando (D-44); a descrição já passou pelo filtro de frases proibidas. */
  seam: boolean;
  seamDescription: string;
}

const sentence = (text: string): string => {
  const clean = text.trim();
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
};

/**
 * Aviso de emenda (D-44). Sem emenda, o texto nunca diz que a imagem está sem emenda (G8): o silêncio do juiz não
 * prova nada. Descrição vazia ou barrada: a frase sai sem ela.
 */
function seamNote(description: string): string {
  const detail = description.trim().replace(/[.!]+$/, '');
  return `Na conferência, vi o que parece uma emenda ou um objeto flutuando${detail ? `: ${detail}` : ''}. Diga o que ajustar ou peça para voltar.`;
}

/**
 * Resposta depois da imagem (G8): montada pelo código a partir do que o juiz conferiu. O resultado já foi aplicado
 * em todos os casos (D-26). Sem juiz (`null`), diz que não conseguiu conferir.
 */
export function afterImageReply(facts: JudgeFacts | null): string {
  if (!facts) {
    return 'Apliquei a imagem nova, mas não consegui conferir o resultado. Veja se ficou como pediu.';
  }
  const changed = sentence(facts.changed);
  const head =
    facts.satisfied === 'sim'
      ? `Conferi a imagem nova: ${changed}`
      : facts.satisfied === 'parcial'
        ? `Conferi a imagem nova e o pedido foi atendido em parte: ${changed} Diga o que ajustar ou peça para voltar.`
        : `Apliquei a imagem nova, mas na conferência o pedido não aparece atendido: ${changed} Diga o que ajustar ou use "Voltar para a anterior".`;
  const notes: string[] = [];
  if (facts.missing.length) {
    notes.push(
      `Ainda não vi na imagem: ${facts.missing.map((item) => item.replace(/[.!]+$/, '')).join('; ')}.`,
    );
  }
  if (facts.textInImage) {
    notes.push('Vi texto na imagem nova; se quiser texto, ele fica melhor como camada.');
  }
  if (facts.seam) notes.push(seamNote(facts.seamDescription));
  return [head, ...notes].join(' ');
}

/** Fato do sistema, não do modelo: a versão atual (D-23: o número exibido). */
export const currentVersionReply = (displayNumber: number): string =>
  `A versão atual é a ${displayNumber}.`;

/** Resposta sobre a imagem: sempre apresentada como leitura do que o modelo vê. */
export const askedAboutImageReply = (reply: string): string => `Pelo que vejo na imagem: ${reply}`;

/** Marcação que não vale para imagem nova (`/images/generations` não recebe `markup`). */
export const MARKING_DISCARDED_NOTE = 'A área marcada não vale para uma imagem nova.';

export const layerReply = (changed: string[]): string =>
  `Alterado apenas: ${changed.map((name) => name.toLowerCase()).join(', ')}. A imagem de fundo não mudou.`;

const FAILURE_REPLIES: Record<SceneFailureCode, string> = {
  PROVIDER_QUOTA: 'O serviço de imagem está sem saldo. Avise o administrador.',
  PROVIDER_CONTENT_POLICY:
    'O serviço de imagem recusou este pedido pela política de conteúdo. Descreva a cena de outro jeito.',
  PROVIDER_TIMEOUT: 'O serviço de imagem demorou demais para responder. Tente de novo.',
  PROVIDER_ERROR: 'Não consegui gerar a imagem agora. Tente de novo em instantes.',
  JOB_EXPIRED: 'O processamento foi interrompido. Tente de novo.',
  PAID_CALL_LIMIT:
    'Atingi o limite de chamadas ao serviço de imagem para este pedido. Tente de novo com um pedido mais simples.',
  DIRECTOR_UNAVAILABLE: 'Não consegui ler seu pedido agora. Nada foi alterado.',
};

export function failureReply(code: SceneFailureCode): string {
  return FAILURE_REPLIES[code];
}
