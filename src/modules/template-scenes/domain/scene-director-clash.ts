import { fold } from '../../../shared/text/fold';
import { DirectorPlan } from './scene-director-schema';

/**
 * Trava de D-59 (B5, PV-111): duas frases diferentes pedidas para o mesmo lugar são uma mensagem que se contradiz, e
 * o Diretor real nem sempre pergunta (a mensagem do dono virou imagem com as duas frases na mesma placa). A regra é
 * estreita e não lê o sentido da mensagem: o plano pinta duas ou mais linhas NOVAS e sem número em `exact_text`, que é
 * um bloco só (a mesma placa ou região), e a mensagem não pediu linhas separadas.
 */

/** Pedido de linhas separadas: posição ("embaixo"), ordem ("depois"), "linha", título e subtítulo, ou quebra de linha. */
const SEPARATE_LINES =
  /\b(embaixo|em baixo|abaixo|debaixo|por baixo|em cima|acima|linhas?|depois|em seguida|titulo|subtitulo|primeira|segunda)\b/;

export const CLASH_RETRY_REASON =
  'o plano pinta duas frases diferentes no mesmo lugar e a mensagem não pediu linhas separadas: se a mensagem se contradiz, não mude a imagem (will_change_image false, image nulo, requests vazio) e pergunte em reply qual das duas frases fica, citando as duas; se não se contradiz, deixe em exact_text só a frase pedida';

const hasDigit = (line: string): boolean => /\p{N}/u.test(line);

const asksSeparateLines = (message: string): boolean =>
  /[\r\n]/.test(message.trim()) || SEPARATE_LINES.test(fold(message));

/** As linhas de `exact_text` que o plano traz de novo: sem número e que não são texto já pintado nem de camada. */
function newLines(plan: DirectorPlan, known: string[]): string[] {
  const seen = new Set(known.map((line) => fold(line).trim()));
  return (plan.image?.exact_text ?? []).filter(
    (line) => !hasDigit(line) && !seen.has(fold(line).trim()),
  );
}

export type ClashCheck = { clash: false } | { clash: true; lines: [string, string] };

/** As duas primeiras frases em disputa, ou `clash: false`. Só vale para plano que chama a imagem. */
export function findClash(
  plan: DirectorPlan,
  input: { message: string; known: string[] },
): ClashCheck {
  const lines = newLines(plan, input.known);
  if (lines.length < 2 || asksSeparateLines(input.message)) return { clash: false };
  return { clash: true, lines: [lines[0], lines[1]] };
}
