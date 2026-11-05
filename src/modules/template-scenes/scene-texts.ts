import { SceneFailureCode, SceneZoneName } from './domain/scene.types';

/** Mensagens do assistente no chat da cena (pt-BR). */

export const READY_REPLY =
  'Pronto! Gerei a cena no tamanho do formato. Veja a prévia ao lado e use as camadas para o texto e o logo.';

export const CANCELLED_REPLY = 'Geração cancelada.';

/** Respostas imediatas (sem job pago): o pedido não gera versão nova. */
export const NEEDS_REGION_REPLY =
  'Marque a área na prévia (retângulo, pincel ou laço) para eu saber onde mudar. Nada foi alterado.';

export const NEEDS_REGION_LAYER_REPLY =
  'Logo e texto não passam pelo modelo de imagem. Selecione o elemento para movê-lo ou redimensioná-lo, ou marque a área do fundo que você quer mudar.';

export const MOVE_UNAVAILABLE_REPLY =
  'Não consigo mover um item que faz parte da imagem sem refazê-lo. Posso removê-lo daqui (marque a área) e desenhar um novo onde você marcar.';

export const GLOBAL_CONFIRM_REPLY =
  'Isso cria uma nova versão do fundo inteiro. Logo e texto não mudam.';

export const NEW_IMAGE_CONFIRM_REPLY =
  'Isso gera uma imagem nova do zero, como uma nova versão, e custa cerca de US$ 0,13. As versões anteriores continuam em Versões. Logo, texto e elementos adicionados ficam como estão.';

export const CHOOSE_LAYER_REPLY =
  'Há mais de uma camada possível. Selecione na prévia a camada que quer integrar ao fundo. Nada foi alterado.';

export const needsPlaceReply = (subject: string): string =>
  `Marque onde quer "${subject}" e envie de novo. Nada foi alterado.`;

export const NO_CHANGE_REPLY =
  'Não vi mudança na área marcada. Quer tentar de novo? Marque a área de novo ou descreva de outro jeito.';

const brl = (usd: number): string => `US$ ${usd.toFixed(2).replace('.', ',')}`;

/** Visão: o pedido não foi atendido. A imagem atual fica, e a tentativa (já cobrada) fica em Versões. */
export const notAppliedReply = (changed: string, costUsd: number): string =>
  `Não consegui atender ao pedido: ${changed.trim().replace(/[.!]+$/, '')}. Mantive a imagem atual. Esta tentativa custou ${brl(costUsd)}.`;

const RETRY_HINT = 'Se não ficou como queria, marque a área de novo ou descreva de outro jeito.';

/** Fatos da visão que entram na resposta (a visão é opcional: sem ela, a resposta sai das métricas). */
export interface VisionFacts {
  changed: string;
  satisfied: 'sim' | 'parcial' | 'nao';
}

const endSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Resposta de uma edição local (ou do ajuste geral): a área entendida, o que mudou pela visão, ou pelas
 * métricas. "Preservado" só entra quando a visão confirmou o atendimento (`sim`) numa edição local.
 */
export function editReply(
  vision: VisionFacts | null,
  scope: 'area' | 'scene' = 'area',
  area?: string,
): string {
  const where = area ? `Área: ${area}. ` : '';
  const preserved =
    scope === 'area' ? 'O resto da imagem foi preservado.' : 'Logo e texto não mudaram.';
  if (!vision) {
    return scope === 'area'
      ? `${where}Pronto! Editei a área${area && area !== 'a marcada' ? '' : ' marcada'}.`
      : `Pronto! Criei uma nova versão do fundo. ${preserved}`;
  }
  const changed = endSentence(vision.changed);
  if (vision.satisfied === 'nao') return `${where}${changed} ${RETRY_HINT}`;
  if (vision.satisfied === 'parcial') {
    return `${where}${changed} Atendi o pedido em parte. ${RETRY_HINT}`;
  }
  return `${where}Pronto! ${changed} ${preserved}`;
}

const ADD_PLACE: Record<'area' | 'center' | SceneZoneName, string> = {
  area: 'na área marcada',
  center: 'no centro do miolo',
  header: 'no cabeçalho',
  body: 'no miolo',
  footer: 'no rodapé',
};

export const addElementReply = (subject: string, where: keyof typeof ADD_PLACE): string =>
  `Pronto! Adicionei "${subject}" ${ADD_PLACE[where]}. É uma camada: arraste para onde quiser. O fundo não mudou.`;

export const layerReply = (changed: string[]): string =>
  `Alterado apenas: ${changed.map((name) => name.toLowerCase()).join(', ')}. A imagem de fundo não mudou.`;

export const CROP_TOO_SMALL_REPLY =
  'A área marcada é pequena demais para este formato. Marque uma área maior. Nada foi alterado.';

const FAILURE_REPLIES: Record<SceneFailureCode, string> = {
  PROVIDER_QUOTA: 'O serviço de imagem está sem saldo. Avise o administrador.',
  PROVIDER_CONTENT_POLICY:
    'O serviço de imagem recusou este pedido pela política de conteúdo. Descreva a cena de outro jeito.',
  PROVIDER_TIMEOUT: 'O serviço de imagem demorou demais para responder. Tente de novo.',
  PROVIDER_ERROR: 'Não consegui gerar a imagem agora. Tente de novo em instantes.',
  JOB_EXPIRED: 'O processamento foi interrompido. Tente de novo.',
  PAID_CALL_LIMIT:
    'Atingi o limite de chamadas ao serviço de imagem para este pedido. Tente de novo com um pedido mais simples.',
  RECOMPOSE_MISMATCH:
    'Não consegui aplicar a edição sem alterar o resto da imagem, então descartei o resultado. Tente de novo.',
};

export function failureReply(code: SceneFailureCode): string {
  return FAILURE_REPLIES[code];
}
