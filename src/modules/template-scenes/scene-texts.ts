import { FIXED_CHANGED } from './domain/scene-director-phrases';
import { SceneFailureCode } from './domain/scene.types';
import { TextLine } from './domain/scene-text-check';

/** Mensagens do assistente no chat da cena (pt-BR). */

export const CANCELLED_REPLY = 'Geração cancelada.';

/** Plano com imagem e camada: se a imagem falha ou é parada, nenhuma camada é alterada, e o chat diz (defeito b). */
export const NO_LAYER_CHANGED = 'Nenhuma camada foi alterada.';

/** A camada pedida "embaixo de X" não cabe na página abaixo de X (B3, D-59): nada é criado nem movido. */
export const noRoomBelowReply = (name: string): string =>
  `Não cabe embaixo de “${name}”. Diga onde quer, ou arraste no quadro.`;

/** Aviso da frase que já é camada e agora vai pintada (D-55): a camada de texto sai na mesma versão. */
export const PAINTED_LAYER_NOTE = 'A frase vai ser pintada na imagem, e a camada de texto sai.';

/** A logo é sempre camada (D-51, 4c): pedido de pintar ou integrar a logo não chama imagem. */
export const PAINTED_REFUSAL_REPLIES = {
  painted_logo:
    'A logo fica sempre como camada, para sair exata. Envie a logo pelo clipe, ou me diga onde quer a que já está na cena.',
} as const;

/** Composição que o plano pediu e o cliente não (G4): vira pergunta, sem imagem. */
export const compositionQuestion = (labels: string[]): string =>
  `Você quer ${labels.join(', ')} na imagem? Não incluo isso sem você pedir. Se quiser, me diga como. Nada foi alterado.`;

/** O corte do ano, data ou número (D-42) esvaziou `image.change`: vira pergunta, sem imagem. */
export const NUMBER_QUESTION = 'O que você quer mudar na imagem?';

/** O texto a pintar não está nas mensagens do cliente (4a, G3): pergunta o texto exato, sem imagem. */
export const EXACT_TEXT_QUESTION =
  'Qual é o texto exato que vai na imagem? Escreva do jeito que deve aparecer.';

/** "Esquece isso" sem item em aberto (validação 3). */
export const NO_OPEN_REQUEST_REPLY = 'Não há pedido em aberto para esquecer. Nada foi alterado.';

/** "Esquece isso" com alvo incerto: nada desiste, e o chat pergunta qual. */
export const whichToForgetReply = (items: string[]): string =>
  `Qual destes você quer esquecer: ${items.join(', ')}?`;

/** Aviso do que saiu da lista (G9): o pedido não some em silêncio, mesmo se o alvo for o errado. */
export const droppedNote = (items: string[]): string => `Tirei da lista: ${items.join(', ')}.`;

/** O plano chamaria a imagem sem dizer o que mudar (G2): vira pergunta, sem imagem. */
export const NO_INSTRUCTION_REPLY =
  'Não entendi o que mudar na imagem. Me diga o que você quer que eu faça. Nada foi alterado.';

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

/** O texto pintado a pedido, conferido letra por letra (D-51): o que o código comparou e o que foi feito. */
export interface TextFacts {
  /** Cada linha esperada com o que o juiz leu na leitura que valeu (a da imagem aplicada). */
  lines: TextLine[];
  /** Quantas imagens foram pedidas: 1, ou 2 depois da refação única. */
  tried: 1 | 2;
  /** Não refez porque o limite de chamadas pagas do pedido não deixou. */
  limited: boolean;
  /** A segunda chamada de imagem falhou no provedor, e a primeira imagem foi aplicada. */
  secondFailed?: boolean;
}

/** O que o juiz conferiu, em fatos; o texto ao cliente sai disto, nunca do modelo de imagem nem do Diretor. */
export interface JudgeFacts {
  satisfied: 'sim' | 'parcial' | 'nao';
  /** O que mudou, já sem promessa de preservação; vazio se o juiz não disse ou foi barrado. */
  changed: string;
  /** O que falta, em frase nominal do juiz, já filtrada; vazia se nada falta ou se foi barrada (D-51). */
  missing: string;
  /** O juiz não viu algum item da lista: mesmo sem frase útil, o chat diz que falta parte do pedido. */
  missingAny: boolean;
  /** Texto que ninguém pediu e o juiz viu, já filtrado; vazio se não houver (D-51). */
  extraText: string;
  /** O juiz viu emenda ou objeto flutuando (D-44); a descrição já passou pelo filtro de frases proibidas. */
  seam: boolean;
  seamDescription: string;
  /** Há texto pedido (ou já pintado) e o juiz o leu; ausente quando não havia texto a conferir. */
  text?: TextFacts;
  /** Item aberto da mesma mensagem que esta rodada não fez (D-54): o chat pergunta se faz agora. */
  pendingItem?: string;
}

const sentence = (text: string): string => {
  const clean = text.trim();
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
};

const dropFinal = (text: string): string => text.trim().replace(/[.!]+$/, '');
const quoted = (line: string): string => `“${line}”`;

/**
 * Aviso de emenda (D-44). Sem emenda, o texto nunca diz que a imagem está sem emenda (G8): o silêncio do juiz não
 * prova nada. Descrição vazia ou barrada: a frase sai sem ela.
 */
function seamNote(description: string): string {
  const detail = dropFinal(description);
  return `Na conferência, vi o que parece uma emenda ou um objeto flutuando${detail ? `: ${detail}` : ''}. Diga o que ajustar ou peça para voltar.`;
}

/** Quantas vezes o código tentou, e por que parou antes da segunda. */
function triedNote(text: TextFacts): string {
  if (text.limited) {
    return 'Tentei uma vez e não refiz porque atingi o limite de chamadas deste pedido.';
  }
  return text.secondFailed
    ? 'Tentei refazer, mas a segunda tentativa falhou.'
    : 'Tentei duas vezes.';
}

/** Texto certo, ou o que saiu diferente do pedido, com o que foi tentado (D-51, G3b). */
function textNote(text: TextFacts): string {
  const wrong = text.lines.filter((line) => !line.ok);
  if (wrong.length === 0) {
    return `Conferi o texto letra por letra: ${text.lines.map((line) => quoted(line.asked)).join(' / ')}.`;
  }
  const seen = wrong.map((line) =>
    line.read.trim()
      ? `Pedi ${quoted(line.asked)} e li ${quoted(line.read)}.`
      : `Não encontrei na imagem o texto ${quoted(line.asked)}.`,
  );
  const tried = triedNote(text);
  return `O texto na imagem saiu diferente do pedido. ${seen.join(' ')} ${tried} Posso tentar de novo, ou colocar a frase como camada de texto exata.`;
}

/** O que falta: a frase do juiz, ou o texto fixo; o item aberto da mesma mensagem tem pergunta própria (D-54). */
function missingNote(facts: JudgeFacts): string | null {
  if (facts.pendingItem) {
    return `Ainda falta: ${dropFinal(facts.pendingItem)}. Quer que eu faça agora?`;
  }
  if (facts.missing) return `Ainda falta: ${dropFinal(facts.missing)}.`;
  return facts.missingAny ? 'Ainda falta parte do que você pediu.' : null;
}

/** A segunda imagem foi aplicada sem a segunda conferência: o chat não diz que o texto está certo (rodada 6). */
function unconferredRedoNote(redo: { asked: string[]; limit: boolean }): string {
  const why = redo.limit
    ? 'não conferi a segunda tentativa: atingi o limite de chamadas deste pedido.'
    : 'não consegui conferir a segunda tentativa.';
  return `Refiz a imagem porque o texto saiu diferente do pedido, mas ${why} Veja se o texto ficou ${redo.asked.map(quoted).join(' / ')}.`;
}

/**
 * Resposta depois da imagem (G8): montada pelo código a partir do que o juiz conferiu. O resultado já foi aplicado
 * em todos os casos (D-26). Sem juiz (`null`), diz que não conseguiu conferir; com texto pedido, diz também que não
 * conseguiu conferir o texto.
 */
export function afterImageReply(
  facts: JudgeFacts | null,
  options: { textAsked?: boolean; redo?: { asked: string[]; limit: boolean } } = {},
): string {
  if (!facts) {
    const base =
      'Apliquei a imagem nova, mas não consegui conferir o resultado. Veja se ficou como pediu.';
    if (options.redo) return `${base} ${unconferredRedoNote(options.redo)}`;
    return options.textAsked
      ? `${base} Não consegui conferir o texto; veja se ficou como pediu.`
      : base;
  }
  // `changed` vazio (vazio ou barrado pelo filtro): o texto fixo acompanha o veredito e nunca o contradiz (R6).
  const changed = facts.changed.trim() ? ` ${sentence(facts.changed)}` : '';
  const head =
    facts.satisfied === 'sim'
      ? `Conferi a imagem nova: ${changed ? changed.trim() : FIXED_CHANGED}`
      : facts.satisfied === 'parcial'
        ? `Conferi a imagem nova e o pedido foi atendido em parte${changed ? `:${changed}` : '.'} Diga o que ajustar ou peça para voltar.`
        : `Apliquei a imagem nova, mas na conferência o pedido não aparece atendido${changed ? `:${changed}` : '.'} Diga o que ajustar ou use "Voltar para a anterior".`;
  const notes = [
    facts.text ? textNote(facts.text) : null,
    missingNote(facts),
    facts.extraText
      ? `Vi na imagem um texto que você não pediu: ${quoted(dropFinal(facts.extraText))}. Diga se quer que eu tire.`
      : null,
    facts.seam ? seamNote(facts.seamDescription) : null,
  ].filter((note): note is string => note !== null);
  return [head, ...notes].join(' ');
}

/** Fato do sistema, não do modelo: a versão atual (D-23: o número exibido). */
export const currentVersionReply = (displayNumber: number): string =>
  `A versão atual é a ${displayNumber}.`;

/** Marcação que não vale para imagem nova (`/images/generations` não recebe `markup`). */
export const MARKING_DISCARDED_NOTE = 'A área marcada não vale para uma imagem nova.';

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
