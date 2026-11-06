import { fold } from '../../../shared/text/fold';
import { DirectorPlan, directorSchema } from './scene-director-schema';

export type {
  DirectorLayerOp,
  DirectorPlan,
  DirectorRequest,
  PaintedRefusal,
  TurnKind,
} from './scene-director-schema';
export { DIRECTOR_JSON_SCHEMA, TURN_KINDS } from './scene-director-schema';

/** O que o código sabe da conversa para validar o plano contra o que o cliente escreveu. */
export interface DirectorValidationContext {
  /** A mensagem atual do cliente, literal. */
  message: string;
  /** Todas as mensagens do cliente (inclusive a atual), em texto literal. */
  clientMessages: string[];
  /** Ids da lista do que o cliente pediu (`brief`), para `drop` e reabertura. */
  briefIds: string[];
}

export type DirectorParse = { ok: true; plan: DirectorPlan } | { ok: false; reason: string };

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const folded = (text: string): string => collapse(fold(text));

/** Palavras de ligação que não provam que o cliente falou do assunto. */
export const FUNCTION_WORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'no',
  'na',
  'nos',
  'nas',
  'um',
  'uma',
  'uns',
  'umas',
  'ao',
  'aos',
  'em',
  'com',
  'por',
  'para',
  'pra',
  'pro',
  'que',
  'se',
  'ou',
  'e',
  'o',
  'a',
  'os',
  'as',
]);

const tokens = (text: string): string[] =>
  fold(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Duas palavras casam quando são iguais ou, a partir de 4 letras, uma é raiz da outra (plural, flexão).
 * Palavras de 2 e 3 letras ("tv", "rio") valem, desde que iguais: sem o corte de 3 letras de antes (O1).
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
}

/** Alguma palavra significativa do pedido aparece em alguma mensagem do cliente. */
function mentionedByClient(text: string, clientMessages: string[]): boolean {
  const known = clientMessages.flatMap(tokens);
  return tokens(text)
    .filter((word) => !FUNCTION_WORDS.has(word))
    .some((word) => known.some((other) => sameWord(word, other)));
}

function textProblem(plan: DirectorPlan, ctx: DirectorValidationContext): string | null {
  for (const op of plan.layer_ops) {
    if (op.text && !collapse(ctx.message).includes(collapse(op.text.value))) {
      return 'texto exato fora da mensagem';
    }
  }
  return null;
}

function layerOpProblem(plan: DirectorPlan): string | null {
  for (const op of plan.layer_ops) {
    if (op.op === 'set_text' && !op.text) return 'set_text sem text';
    if (op.op === 'add_logo' && !op.position) return 'add_logo sem position';
    if ((op.op === 'move' || op.op === 'resize' || op.op === 'remove') && !op.layer) {
      return `${op.op} sem layer`;
    }
    if (op.op === 'resize' && !op.layer?.direction) return 'resize sem direction';
  }
  return null;
}

function requestProblem(plan: DirectorPlan, ctx: DirectorValidationContext): string | null {
  for (const request of plan.requests) {
    if (!mentionedByClient(request.text, ctx.clientMessages)) {
      return `pedido "${request.text}" sem palavra das mensagens do cliente`;
    }
    if (request.id !== null && !ctx.briefIds.includes(request.id) && request.action === 'drop') {
      return 'drop de pedido que não está na lista';
    }
    if (request.action !== 'drop') continue;
    const quote = request.quote ? folded(request.quote) : '';
    if (quote.length < 2 || !folded(ctx.message).includes(quote)) {
      return 'drop sem citação literal na mensagem atual';
    }
  }
  return null;
}

/**
 * Validações 1 a 3 do Diretor (`design.md`): JSON e schema fechado; texto exato de camada literal na
 * mensagem; pedidos (`requests`) com palavra de mensagem do cliente e `drop` com citação literal na mensagem
 * atual. Nunca lança. Falha em qualquer uma refaz o Diretor uma vez, com o motivo.
 */
export function parseDirector(raw: string, ctx: DirectorValidationContext): DirectorParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'JSON inválido' };
  }
  const parsed = directorSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${issue.path.join('.') || 'raiz'} (${issue.message})` };
  }
  const plan = parsed.data;
  const problem = layerOpProblem(plan) ?? textProblem(plan, ctx) ?? requestProblem(plan, ctx);
  return problem ? { ok: false, reason: problem } : { ok: true, plan };
}
