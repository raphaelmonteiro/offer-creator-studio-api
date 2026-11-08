import { fold } from '../../../shared/text/fold';
import { DirectorPlan } from './scene-director-schema';
import { quotedContents } from './scene-exact-text';

/**
 * Validação 9 (rodada 6): em plano que chama imagem, o anúncio (`reply`) só promete o que o plano traz. Depende só do
 * Diretor hoje: sem esta conferência, o anúncio podia prometer gravação com `exact_text` vazio, camada sem `layer_ops`
 * ou uma frase que a validação 4b cortou. Quem chama passa o plano final, já sem os trechos cortados.
 */

export interface AnnounceSources {
  /** Linhas já pintadas e conferidas na versão atual. */
  paintedText: string[];
  /** Texto de cada camada de texto da cena. */
  layerTexts: string[];
}

export type AnnounceCheck = { ok: true } | { ok: false; reason: string };

export const ANNOUNCE_RETRY_REASON =
  'o anúncio promete o que o plano não traz: cite entre aspas só frase que está em image.exact_text, em layer_ops ou já pintada; só fale de escrita com exact_text preenchido; só fale de placa se image.change a descreve (sign, board, plaque ou placard); só prometa camada com layer_ops';

const normalized = (text: string): string =>
  text
    .replace(/[“”«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const WRITING =
  /\b(?:escrit\w*|gravad\w*|gravacao|com a frase|com o texto|com os dizeres|letreiros?)\b/;
const SIGN = /\b(?:placas?|cartaz(?:es)?|letreiros?)\b/;
const SIGN_IN_CHANGE = /\b(?:sign|board|plaque|placard)s?\b/i;
const LAYER = /\b(?:camadas?|editaveis|editavel)\b/;
const CONDITIONAL = /\bse (?:quiser|preferir)\b/;
const REMOVAL = /\b(?:tir\w*|remov\w*|apag\w*)\b/;

/** A frase da oração de `index` em diante: o que vem antes dele, até o ponto, o ponto e vírgula ou a exclamação. */
const clauseBefore = (folded: string, index: number): string =>
  folded
    .slice(0, index)
    .split(/[.;!?]/)
    .pop() ?? '';

/** Alguma ocorrência do padrão que não vem depois de verbo de tirar na mesma oração. */
function promises(folded: string, pattern: RegExp): boolean {
  const all = new RegExp(pattern.source, 'g');
  return [...folded.matchAll(all)].some(
    (match) => !REMOVAL.test(clauseBefore(folded, match.index as number)),
  );
}

function knownPhrases(plan: DirectorPlan, sources: AnnounceSources): Set<string> {
  const layerOpTexts = plan.layer_ops.flatMap((op) => (op.text ? [op.text.value] : []));
  return new Set(
    [
      ...(plan.image?.exact_text ?? []),
      ...layerOpTexts,
      ...sources.paintedText,
      ...sources.layerTexts,
    ]
      .map(normalized)
      .filter(Boolean),
  );
}

const fail = (detail: string): AnnounceCheck => ({
  ok: false,
  reason: `${ANNOUNCE_RETRY_REASON} (o anúncio ${detail})`,
});

/** O anúncio promete frase, escrita, placa ou camada que o plano não traz? */
export function checkAnnouncement(plan: DirectorPlan, sources: AnnounceSources): AnnounceCheck {
  const reply = plan.reply.trim();
  if (!reply) return { ok: true };
  const known = knownPhrases(plan, sources);
  const phrase = quotedContents(reply).find((text) => !known.has(normalized(text)));
  if (phrase !== undefined)
    return fail(`cita a frase “${phrase}”, que o plano não pinta nem põe em camada`);
  const folded = fold(reply);
  const writes =
    (plan.image?.exact_text.length ?? 0) > 0 || plan.layer_ops.some((op) => op.op === 'set_text');
  if (!writes && promises(folded, WRITING)) return fail('anuncia escrita com exact_text vazio');
  const change = plan.image?.change ?? '';
  if (promises(folded, SIGN) && !SIGN_IN_CHANGE.test(change)) {
    return fail('promete placa, e image.change não descreve uma');
  }
  const conditional = CONDITIONAL.test(folded);
  if (plan.layer_ops.length === 0 && !conditional && promises(folded, LAYER)) {
    return fail('promete camada com layer_ops vazio');
  }
  return { ok: true };
}
