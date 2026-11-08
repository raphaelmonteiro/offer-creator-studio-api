import type { DirectorCompletionResult } from '../../ai/openai-director.service';
import type { DirectorImage, DirectorPlan } from '../domain/scene-director-schema';
import { fold } from '../../../shared/text/fold';
import {
  clean,
  contradictionPlan,
  EMPTY,
  has,
  imageOf,
  imagePlan,
  layerPlan,
  logoRefusal,
  openRequest,
  quotedLines,
  undoPlan,
} from './mock-scene-director-plans';
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
  /** A mensagem se contradiz: pergunta curta com as opções, sem imagem e sem item (D-59). */
  contradiction: '#plano-contradicao',
} as const;

const LOGO_ASK = /\b(?:integra\w*|pinta\w*|desenha\w*) a logo\b/;

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
 * pediu), `#plano-ano` (leva o ano ao pedido de imagem) e `#plano-contradicao` (mensagem que se contradiz: pergunta
 * curta, sem imagem e sem item).
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
    if (hasMarker(markers.contradiction)) return contradictionPlan(message);
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
