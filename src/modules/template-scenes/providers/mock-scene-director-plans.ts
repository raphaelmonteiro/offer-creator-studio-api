import type { DirectorImage, DirectorPlan } from '../domain/scene-director-schema';
import { fold } from '../../../shared/text/fold';
import type { DirectorScript } from './scene-director-client';

/** Os planos que o Diretor simulado devolve por roteiro (D-23): camada, desfazer, imagem e a recusa da logo. */

export const WHOLE: DirectorImage['region'] = { zone: 'whole', side: null };

export const EMPTY: DirectorPlan = {
  turn_kind: 'outro',
  will_change_image: false,
  reply: '',
  image: null,
  what_i_see: 'Imagem de teste (mock).',
  undo_target: null,
  layer_ops: [],
  requests: [],
  refusal: null,
};

/** Blocos de imagem do mock: a mudança em texto do cliente, a região pela marcação e o texto entre aspas. */
export function imageOf(
  change: string,
  script: DirectorScript,
  exact: string[] = [],
): DirectorImage {
  return {
    composition: '',
    style: '',
    change,
    region: { zone: script.marked ? 'marked' : 'whole', side: null },
    preserve: [],
    exact_text: exact,
  };
}

export const quotedLines = (message: string): string[] =>
  [...message.matchAll(/["“«]([^"”»]+)["”»]/g)].map((match) => match[1].trim()).slice(0, 4);

export const has = (folded: string, pattern: RegExp): boolean => pattern.test(folded);
/** Tira só os marcadores do Diretor e do juiz: os do provedor de imagem (`#lento`, `#falha-*`) seguem no pedido. */
export const clean = (message: string): string =>
  message
    .replace(/#(?:diretor|plano|juiz)-[\w-]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Item pedido: o texto do cliente vira um pedido novo, sem id. */
export const openRequest = (text: string): DirectorPlan['requests'][number] => ({
  id: null,
  text,
  action: 'open',
  quote: null,
});

/** A operação sobre a camada que já existe (logo ou texto): tirar, mudar o tamanho ou mover. */
function existingLayerOp(folded: string): DirectorPlan['layer_ops'][number] {
  const kind = has(folded, /\blogo\b/) ? 'logo' : 'text';
  const op = has(folded, /\b(tira|remove|apaga)\b/)
    ? 'remove'
    : has(folded, /\b(maior|menor)\b/)
      ? 'resize'
      : 'move';
  const moveSide = has(folded, /\besquerda\b/)
    ? 'left'
    : has(folded, /\bdireita\b/)
      ? 'right'
      : 'toggle';
  return {
    op,
    layer: {
      kind,
      name: null,
      side: op === 'move' ? moveSide : null,
      direction: op === 'resize' ? (has(folded, /\bmenor\b/) ? 'smaller' : 'bigger') : null,
    },
    text: null,
    position: null,
    replace: false,
  };
}

/** Texto entre aspas como camada. B3 (D-59): "embaixo dela" cita a logo, que o código resolve entre as camadas. */
function textOp(
  quoted: string,
  folded: string,
  script: DirectorScript,
): NonNullable<DirectorPlan['layer_ops']>[number] {
  const below = has(folded, /\b(embaixo|abaixo)\b/);
  const logoThere = script.hasLogoAttachment || script.layers.some((l) => l.kind === 'logo');
  return {
    op: 'set_text',
    layer: null,
    text: { value: quoted, placement: below ? 'below-logo' : 'bottom' },
    position:
      below && logoThere
        ? { side: 'left', zone: 'header', below: { kind: 'logo', name: null } }
        : null,
    replace: false,
  };
}

export function layerPlan(
  script: DirectorScript,
  folded: string,
  message: string,
): DirectorPlan | null {
  // D-51: texto entre aspas é pintado; só vira camada quando o cliente pede texto editável ou camada.
  const asksLayer = has(folded, /\b(?:camada|editavel|editaveis)\b/);
  const quoted = asksLayer ? message.match(/["“«]([^"”»]+)["”»]/)?.[1] : undefined;
  const ops: DirectorPlan['layer_ops'] = [];
  if (script.hasLogoAttachment) {
    const side = has(folded, /\bdireita\b/)
      ? 'right'
      : has(folded, /\bcentro\b/)
        ? 'center'
        : 'left';
    const zone = has(folded, /\brodape\b/)
      ? 'footer'
      : has(folded, /\bmiolo\b/)
        ? 'body'
        : 'header';
    ops.push({ op: 'add_logo', layer: null, text: null, position: { side, zone }, replace: false });
  }
  if (quoted) {
    ops.push(textOp(quoted, folded, script));
  }
  if (!ops.length && script.layers.length && has(folded, /\b(logo|texto)\b/)) {
    ops.push(existingLayerOp(folded));
  }
  if (!ops.length && has(folded, /\b(logo)\b/) && !script.layers.length) {
    ops.push({
      op: 'move',
      layer: { kind: 'logo', name: null, side: 'right', direction: null },
      text: null,
      position: null,
      replace: false,
    });
  }
  return ops.length
    ? { ...EMPTY, turn_kind: 'camada', reply: 'Vou ajustar as camadas.', layer_ops: ops }
    : null;
}

export function undoPlan(folded: string): DirectorPlan | null {
  if (!has(folded, /\b(volta|voltar|desfaz|desfazer)\b/)) return null;
  const number = folded.match(/\bversao\s+(\d+)/)?.[1];
  return {
    ...EMPTY,
    turn_kind: 'desfazer',
    reply: 'Vou voltar.',
    undo_target: number ? Number(number) : 'previous',
  };
}

export function imagePlan(script: DirectorScript, folded: string, message: string): DirectorPlan {
  const base = {
    ...EMPTY,
    will_change_image: true,
    image: imageOf(message, script, quotedLines(message)),
  };
  if (!script.hasImage || has(folded, /\b(outra imagem|gere outra|gera outra|refaz tudo)\b/)) {
    return {
      ...base,
      turn_kind: 'imagem_nova',
      reply: 'Vou criar a imagem.',
      image: { ...imageOf(message, script, quotedLines(message)), region: WHOLE },
      requests: [openRequest(message)],
    };
  }
  if (script.marked && has(folded, /^marquei\b/)) {
    const open = script.openRequests[0];
    return open
      ? {
          ...base,
          turn_kind: 'marcacao_sem_pedido',
          reply: 'Vou fazer o pedido na área marcada.',
          image: imageOf(open.text, script),
        }
      : {
          ...EMPTY,
          turn_kind: 'marcacao_sem_pedido',
          reply: 'O que você quer fazer na área marcada?',
        };
  }
  if (has(folded, /\b(nao era isso|nao foi isso)\b/)) {
    return { ...EMPTY, turn_kind: 'reclamacao', reply: 'O que ainda precisa ser corrigido?' };
  }
  if (has(folded, /\b(mais quente|mais frio|mais claro|mais escuro|estilo|aquarela|tons?)\b/)) {
    return {
      ...base,
      turn_kind: 'pedido_ajuste_geral',
      reply: 'Vou ajustar a imagem toda.',
      requests: [openRequest(message)],
    };
  }
  if (has(folded, /\b(reorganiza|composicao|distribui)\b/)) {
    return {
      ...base,
      turn_kind: 'pedido_composicao',
      reply: 'Vou reorganizar a imagem.',
      requests: [openRequest(message)],
    };
  }
  return {
    ...base,
    turn_kind: 'pedido_item',
    reply: `Vou fazer: ${message}`.slice(0, 250),
    requests: [openRequest(message)],
  };
}

export function logoRefusal(): DirectorPlan {
  return {
    ...EMPTY,
    turn_kind: 'recusa_pintado',
    reply: 'A logo fica como camada.',
    refusal: 'painted_logo',
  };
}

/**
 * As duas opções de uma mensagem que se contradiz (D-59): as frases entre aspas, ou, sem aspas, o texto escrito
 * "escreve (nela) X, ... o texto Y fique", ou o objeto colocado e tirado na mesma mensagem.
 */
function contradictionOptions(message: string): string[] {
  const quoted = quotedLines(message);
  if (quoted.length >= 2) return quoted.slice(0, 2);
  const written = /\bescreve\w*(?: nela| nele)?\s+(.+?)\s*,.*?\btexto\s+(.+?)\s+fique\b/i.exec(
    message,
  );
  if (written) return [written[1], written[2]];
  const removed =
    /\b(?:coloca|poe|bota)\s+(?:um|uma)\s+(\w+).*\b(?:tira|remove)\s+(?:o|a)\s+\1\b/i.exec(
      fold(message),
    );
  return removed ? [`colocar ${removed[1]}`, `tirar ${removed[1]}`] : [];
}

/** Mensagem que se contradiz: pergunta curta com as opções, sem imagem, sem pedido e sem camada (D-59). */
export function contradictionPlan(message: string): DirectorPlan {
  const options = contradictionOptions(message);
  const reply =
    options.length === 2
      ? `Qual você quer: “${options[0]}” ou “${options[1]}”?`
      : 'Esses pedidos não podem valer juntos. Qual deles você quer?';
  return { ...EMPTY, turn_kind: 'outro', will_change_image: false, reply };
}

/** O pedido de fazer o verso ("faz o verso", "agora cria o verso"): só vale na cena de frente e verso. */
export const BACK_ASK = /\b(?:faz|fazer|faca|cria|criar|gera|gerar)\w* (?:o |um )?verso\b/;

/**
 * Plano de `fazer_verso`: sem imagem (o código deriva o verso). O que vier depois de "com" ("faz o verso com
 * bandeirinhas") é o pedido extra, que fica em aberto no brief.
 */
export function backPlan(message: string): DirectorPlan {
  const extra = /\bverso\s+com\s+(.+)$/i.exec(message)?.[1]?.trim();
  return {
    ...EMPTY,
    turn_kind: 'fazer_verso',
    reply: 'Vou fazer o verso a partir da frente.',
    requests: extra ? [openRequest(extra)] : [],
  };
}
