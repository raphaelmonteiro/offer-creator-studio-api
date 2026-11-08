import type { DirectorCompletionResult } from '../../ai/openai-director.service';
import type { DirectorImage, DirectorPlan } from '../domain/scene-director-schema';
import { fold } from '../../../shared/text/fold';
import type { DirectorScript, SceneDirectorCall } from './scene-director-client';

/** Marcadores na mensagem que simulam o Diretor (D-23: o mock é por roteiro, sem custo e sem rede). */
export const MOCK_DIRECTOR_MARKERS = {
  fail: '#diretor-falha',
  invalid: '#diretor-invalido',
  /** O modelo recusa pintar a logo (D-51: a logo é sempre camada). */
  logo: '#plano-logo',
  /** Placa com a frase entre aspas da mensagem em `exact_text` (D-51). */
  text: '#plano-texto',
  /** O modelo inventa a linha de `exact_text`: o código refaz e, persistindo, pergunta. */
  inventedText: '#plano-texto-inventado',
  /** O modelo põe aspas fora do bloco exato: o código refaz e, persistindo, tira só o trecho. */
  quotesOutside: '#plano-aspas-fora',
  /** O plano traz moldura que ninguém pediu: o código refaz e, persistindo, pergunta. */
  frame: '#plano-moldura',
  /** O plano leva o ano ao pedido de imagem: o código refaz e, persistindo, corta só o trecho. */
  year: '#plano-ano',
} as const;

const WHOLE: DirectorImage['region'] = { zone: 'whole', side: null };

const EMPTY: DirectorPlan = {
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
function imageOf(change: string, script: DirectorScript, exact: string[] = []): DirectorImage {
  return {
    composition: '',
    style: '',
    change,
    region: { zone: script.marked ? 'marked' : 'whole', side: null },
    preserve: [],
    exact_text: exact,
  };
}

const quotedLines = (message: string): string[] =>
  [...message.matchAll(/["“«]([^"”»]+)["”»]/g)].map((match) => match[1].trim()).slice(0, 4);

const has = (folded: string, pattern: RegExp): boolean => pattern.test(folded);
/** Tira só os marcadores do Diretor e do juiz: os do provedor de imagem (`#lento`, `#falha-*`) seguem no pedido. */
const clean = (message: string): string =>
  message
    .replace(/#(?:diretor|plano|juiz)-[\w-]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Item pedido: o texto do cliente vira um pedido novo, sem id. */
const openRequest = (text: string): DirectorPlan['requests'][number] => ({
  id: null,
  text,
  action: 'open',
  quote: null,
});

function layerPlan(script: DirectorScript, folded: string, message: string): DirectorPlan | null {
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
    const placement = has(folded, /\b(embaixo|abaixo)\b/) ? 'below-logo' : 'bottom';
    ops.push({
      op: 'set_text',
      layer: null,
      text: { value: quoted, placement },
      position: null,
      replace: false,
    });
  }
  if (!ops.length && script.layers.length && has(folded, /\b(logo|texto)\b/)) {
    const kind = has(folded, /\blogo\b/) ? 'logo' : 'text';
    const op = has(folded, /\b(tira|remove|apaga)\b/)
      ? 'remove'
      : has(folded, /\b(maior|menor)\b/)
        ? 'resize'
        : 'move';
    ops.push({
      op,
      layer: {
        kind,
        name: null,
        side:
          op === 'move'
            ? has(folded, /\besquerda\b/)
              ? 'left'
              : has(folded, /\bdireita\b/)
                ? 'right'
                : 'toggle'
            : null,
        direction: op === 'resize' ? (has(folded, /\bmenor\b/) ? 'smaller' : 'bigger') : null,
      },
      text: null,
      position: null,
      replace: false,
    });
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

function undoPlan(folded: string): DirectorPlan | null {
  if (!has(folded, /\b(volta|voltar|desfaz|desfazer)\b/)) return null;
  const number = folded.match(/\bversao\s+(\d+)/)?.[1];
  return {
    ...EMPTY,
    turn_kind: 'desfazer',
    reply: 'Vou voltar.',
    undo_target: number ? Number(number) : 'previous',
  };
}

function imagePlan(script: DirectorScript, folded: string, message: string): DirectorPlan {
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

const LOGO_ASK = /\b(?:integra\w*|pinta\w*|desenha\w*) a logo\b/;

function logoRefusal(): DirectorPlan {
  return {
    ...EMPTY,
    turn_kind: 'recusa_pintado',
    reply: 'A logo fica como camada.',
    refusal: 'painted_logo',
  };
}

function planFor(script: DirectorScript, message: string): DirectorPlan {
  const folded = fold(message);
  if (has(folded, LOGO_ASK)) return logoRefusal();
  const direct = undoPlan(folded) ?? layerPlan(script, folded, message);
  if (direct) return direct;
  if (has(folded, /\b(obrigad[oa]|otimo|valeu)\b/) && script.hasImage) {
    return { ...EMPTY, turn_kind: 'agradecimento', reply: 'Que bom que gostou!' };
  }
  if (has(folded, /^confirmar\s*$/)) {
    return { ...EMPTY, turn_kind: 'outro', reply: 'O que você quer confirmar?' };
  }
  if (script.hasImage && message.includes('?')) {
    return { ...EMPTY, turn_kind: 'pergunta', reply: 'Vejo a imagem da cena.' };
  }
  return imagePlan(script, folded, message);
}

/**
 * Diretor de desenvolvimento: sem rede e sem custo. Escolhe o plano por roteiro (mensagem + estado da cena),
 * para exercitar contexto, janela, camadas, desfazer, recusa e falha. Marcadores: `#diretor-falha` (erro),
 * `#diretor-invalido` (resposta fora do schema), `#plano-logo` (recusa pintar a logo), `#plano-texto` (placa com
 * a frase entre aspas), `#plano-texto-inventado`, `#plano-aspas-fora`, `#plano-moldura` (moldura que ninguém
 * pediu) e `#plano-ano` (leva o ano ao pedido de imagem).
 */
export class MockSceneDirectorClient {
  async plan(input: SceneDirectorCall): Promise<DirectorCompletionResult> {
    const { message } = input.script;
    if (message.includes(MOCK_DIRECTOR_MARKERS.fail)) {
      throw new Error('Mock: Diretor indisponível');
    }
    const text = message.includes(MOCK_DIRECTOR_MARKERS.invalid)
      ? 'não é json'
      : JSON.stringify(this.answer(input.script));
    return {
      text,
      usage: { input_tokens: 0, output_tokens: 0 },
      requestId: 'mock-director',
      latencyMs: 0,
    };
  }

  private answer(script: DirectorScript): DirectorPlan {
    const message = clean(script.message);
    const plan = planFor(script, message);
    const markers = MOCK_DIRECTOR_MARKERS;
    const hasMarker = (marker: string): boolean => script.message.includes(marker);
    const asEdit = (image: DirectorImage): DirectorPlan => ({
      ...imagePlan({ ...script, hasImage: true }, '', message),
      turn_kind: 'pedido_item',
      image,
      requests: [openRequest(message)],
    });
    if (hasMarker(markers.logo)) return logoRefusal();
    if (hasMarker(markers.inventedText)) {
      return asEdit(imageOf('Add a sign with a promotional text', script, ['Oferta R$ 9,90']));
    }
    if (hasMarker(markers.text)) {
      const lines = quotedLines(message);
      return asEdit({
        ...imageOf('Add a modest wooden sign with the requested text', script, lines),
        region: { zone: script.marked ? 'marked' : 'footer', side: null },
        preserve: ['the existing artwork'],
      });
    }
    if (hasMarker(markers.quotesOutside)) {
      return asEdit(imageOf('Add a sign reading “SALE 50% OFF”', script));
    }
    if (hasMarker(markers.year)) {
      const first = !script.hasImage;
      const change = 'Easter eggs and a bunny, with visual references to Easter and the year 2027';
      return {
        ...imagePlan(script, '', message),
        turn_kind: first ? 'imagem_nova' : 'pedido_item',
        image: imageOf(change, script),
        requests: [openRequest(message)],
      };
    }
    if (hasMarker(markers.frame)) {
      return asEdit({
        ...imageOf('Frame the scene', script),
        composition: 'a frame around the page',
      });
    }
    return plan;
  }
}
