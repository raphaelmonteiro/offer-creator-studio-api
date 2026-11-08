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

/** Faces (change add-template-scene-faces): textos fixos do código, nunca do modelo. */
export const DERIVE_BACK_MESSAGE = 'Fazer o verso';

export const DERIVE_BACK_ANNOUNCEMENT =
  'Vou fazer o verso a partir da frente atual, sem cabeçalho e com o rodapé livre.';

export const DERIVE_BACK_REPLY =
  'Pronto, fiz o verso a partir da frente atual. Peça aqui os ajustes do verso.';

export const BACK_MISSING_REPLY =
  'O verso ainda não existe. Use “Fazer o verso” e depois peça o ajuste.';

export const BACK_EXISTS_REPLY =
  'O verso já existe e nasce da frente. Peça aqui o ajuste que quer no verso, ou volte a uma versão anterior dele.';

export const FRONT_FIRST_REPLY = 'Faça a frente primeiro; o verso nasce dela.';

export const SINGLE_FACE_REPLY =
  'Esta cena tem uma face só. Para ter verso, crie uma cena de frente e verso.';

/** Jornal de 4 páginas (change add-template-scene-tabloid): a Interna nasce da Externa como o verso nasce da frente. */
export const DERIVE_INNER_MESSAGE = 'Fazer a interna';

export const DERIVE_INNER_ANNOUNCEMENT =
  'Vou fazer a interna a partir da externa atual: uma arte contínua, sem cabeçalho, sem rodapé e sem texto.';

export const DERIVE_INNER_REPLY =
  'Pronto, fiz a interna a partir da externa atual. Peça aqui os ajustes das páginas 2 e 3.';

export const INNER_MISSING_REPLY =
  'A interna ainda não existe. Use “Fazer a interna” e depois peça o ajuste.';

export const INNER_EXISTS_REPLY =
  'A interna já existe e nasce da externa. Peça aqui o ajuste que quer nela, ou volte a uma versão anterior.';

export const OUTER_FIRST_REPLY = 'Faça a externa primeiro; a interna nasce dela.';

/** Os textos fixos da derivação da segunda face, por layout de duas faces. */
export interface DeriveTexts {
  message: string;
  announcement: string;
  reply: string;
  missing: string;
  exists: string;
  first: string;
}

export const DERIVE_TEXTS: Readonly<Record<'front_back' | 'tabloid', DeriveTexts>> = {
  front_back: {
    message: DERIVE_BACK_MESSAGE,
    announcement: DERIVE_BACK_ANNOUNCEMENT,
    reply: DERIVE_BACK_REPLY,
    missing: BACK_MISSING_REPLY,
    exists: BACK_EXISTS_REPLY,
    first: FRONT_FIRST_REPLY,
  },
  tabloid: {
    message: DERIVE_INNER_MESSAGE,
    announcement: DERIVE_INNER_ANNOUNCEMENT,
    reply: DERIVE_INNER_REPLY,
    missing: INNER_MISSING_REPLY,
    exists: INNER_EXISTS_REPLY,
    first: OUTER_FIRST_REPLY,
  },
};

/** Altura do cabeçalho da capa pela conversa (D-1, PV-T9). Textos fixos do código, nunca do modelo. */
export const NO_HEADER_ON_INNER_REPLY =
  'A interna não tem cabeçalho; ela é uma arte contínua das páginas 2 e 3.';

export const HEADER_ONLY_TABLOID_REPLY =
  'Por enquanto, a altura do cabeçalho só muda no jornal de 4 páginas.';

const cmText = (cm: number): string => String(cm).replace('.', ',');

export function headerSameReply(cm: number, limit: 'max' | 'min' | null): string {
  if (limit === 'max') return `O cabeçalho já está no máximo, ${cmText(cm)} cm.`;
  if (limit === 'min') return `O cabeçalho já está no mínimo, ${cmText(cm)} cm.`;
  return `O cabeçalho já está com ${cmText(cm)} cm.`;
}

/** Anúncio antes da imagem; pedido fora do limite fica no limite e o anúncio diz o máximo ou o mínimo. */
export function headerAnnouncement(cm: number, limit: 'max' | 'min' | null): string {
  const note =
    limit === 'max'
      ? ` (o máximo é ${cmText(cm)} cm)`
      : limit === 'min'
        ? ` (o mínimo é ${cmText(cm)} cm)`
        : '';
  return `Vou deixar o cabeçalho da capa com ${cmText(cm)} cm${note}.`;
}

export const headerReadyReply = (cm: number): string =>
  `Pronto, o cabeçalho da capa está com ${cmText(cm)} cm.`;

/** Pedido de tamanho junto da imagem que passou do limite: o anúncio da imagem diz o limite aplicado. */
export const headerLimitNote = (cm: number, limit: 'max' | 'min'): string =>
  `O cabeçalho da capa vai ficar com ${cmText(cm)} cm (${limit === 'max' ? 'o máximo' : 'o mínimo'} é ${cmText(cm)} cm).`;

/** PV-T11: a logo que saía do cabeçalho encolhido foi ajustada ao novo espaço da logo. */
export const LOGO_FITTED_NOTE = 'Ajustei a logo ao novo espaço do cabeçalho.';
