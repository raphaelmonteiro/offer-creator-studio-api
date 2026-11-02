import type { Labels } from './labels';

export type Verdict = 'aprovado' | 'reprovado' | 'pendente';

export interface BlockDecision {
  verdict: Verdict;
  /** Resultado da regra de decisão, com o texto fixo do desfecho. */
  text: string;
  /** O que falta rotular (só quando `pendente`, ou informativo). */
  pending: string[];
  detail: string;
}

const A_ATENDEU_MIN = 16;
const A_COSTURA_MIN = 18;
const A_BORDER = [15, 16, 17];

interface MechCount {
  mech: string;
  atendeu: number;
  invisivel: number;
  unlabeled: string[];
  passes: boolean;
  failsFor: boolean;
}

function countMech(labels: Labels, ids: string[], mech: string): MechCount {
  const keys = ids.map((id) => `${id}:${mech}`);
  const get = (k: string, f: string): string | null => labels[k]?.[f] ?? null;
  const atendeu = keys.filter((k) => get(k, 'edicao') === 'atendeu').length;
  const invisivel = keys.filter((k) => get(k, 'costura') === 'invisivel').length;
  const noEdit = keys.filter((k) => get(k, 'edicao') === null);
  const noSeam = keys.filter((k) => get(k, 'costura') === null);
  const failsFor =
    atendeu + noEdit.length < A_ATENDEU_MIN || invisivel + noSeam.length < A_COSTURA_MIN;
  const passes = atendeu >= A_ATENDEU_MIN && invisivel >= A_COSTURA_MIN;
  return {
    mech,
    atendeu,
    invisivel,
    unlabeled: [...new Set([...noEdit, ...noSeam])],
    passes,
    failsFor,
  };
}

/** Bloco A (A1, A2, A3): `mechanisms` só traz os braços realmente medidos (markup recusado fica de fora). */
export function decideA(labels: Labels, ids: string[], mechanisms: string[]): BlockDecision {
  const counts = mechanisms.map((m) => countMech(labels, ids, m));
  const detail = counts
    .map(
      (c) =>
        `${c.mech}: ${c.atendeu}/${ids.length} atendeu, ${c.invisivel}/${ids.length} costura invisivel`,
    )
    .join('; ');
  const passing = counts.filter((c) => c.passes);
  if (passing.length) {
    const best = [...passing].sort(
      (a, b) => b.atendeu - a.atendeu || (a.mech === 'mask' ? -1 : 1),
    )[0];
    const undecided = counts.filter(
      (c) => c !== best && c.unlabeled.length > 0 && c.atendeu + c.unlabeled.length > best.atendeu,
    );
    if (undecided.length) {
      return {
        verdict: 'pendente',
        text: 'pendente: o mecanismo padrão depende dos rótulos que faltam no outro braço',
        pending: undecided.flatMap((c) => c.unlabeled),
        detail,
      };
    }
    const border = A_BORDER.includes(best.atendeu)
      ? ' Fronteira: o dono decide se repete os pedidos com --only, dentro do teto.'
      : '';
    const excl = mechanisms.length === 1 ? ' (por exclusão: o outro braço não foi medido)' : '';
    return {
      verdict: 'aprovado',
      text: `aprovado (A1, A2): estágio 4 segue como desenhado, com o mecanismo ${best.mech}${excl}.${border}`,
      pending: [],
      detail,
    };
  }
  if (counts.length && counts.every((c) => c.failsFor)) {
    return {
      verdict: 'reprovado',
      text: 'reprovado (A3): o estágio 4 não abre; a hipótese volta ao dono para decidir (por exemplo, rever D2 ou o modo header-only)',
      pending: [],
      detail,
    };
  }
  const pending = counts.filter((c) => !c.failsFor).flatMap((c) => c.unlabeled);
  return { verdict: 'pendente', text: 'pendente: faltam rótulos do bloco A', pending, detail };
}

export interface PromoRef {
  id: string;
  atmospheric: boolean;
}

const FALLBACK_TEXT =
  'mover sai do chat; o cliente usa remover (edição local na origem) e adicionar (PNG transparente), e o chat explica que não consegue mover sem refazer o item';

/** Bloco B (B1, B2, B3) e o fallback medido (D-11). `aceitavel` é o único rótulo que conta como aceito. */
export function decideB(labels: Labels, promos: PromoRef[]): BlockDecision {
  const g = (key: string): string | null => labels[key]?.global ?? null;
  const destac = promos.filter((p) => !p.atmospheric);
  const atmos = promos.filter((p) => p.atmospheric);
  const ok = destac.filter((p) => g(`${p.id}:promo`) === 'aceitavel').length;
  const missingPromo = promos
    .filter((p) => g(`${p.id}:promo`) === null)
    .map((p) => `${p.id}:promo`);
  const missingFb = promos
    .filter((p) => g(`${p.id}:fallback`) === null)
    .map((p) => `${p.id}:fallback`);
  const fbOk = promos.filter((p) => g(`${p.id}:fallback`) === 'aceitavel').length;
  const fbBad = missingFb.length === 0 && fbOk < 3;
  const detail = `destacáveis aceitáveis: ${ok}/${destac.length}; fallback aceitável: ${fbOk}/${promos.length}`;
  const missingDestac = destac.filter((p) => g(`${p.id}:promo`) === null).length;
  if (ok + missingDestac < 3) {
    const fb = fbBad ? ` e fallback reprovado: ${FALLBACK_TEXT}` : '';
    const text = fbBad
      ? `promoção abandonada (B3)${fb}`
      : 'promoção abandonada (B3): mover = repintura de origem e destino com aviso';
    return { verdict: 'reprovado', text, pending: fbBad ? [] : missingFb, detail };
  }
  if (missingDestac > 0 || ok < 3)
    return {
      verdict: 'pendente',
      text: 'pendente: faltam rótulos do bloco B',
      pending: missingPromo,
      detail,
    };
  const atmosOk = atmos.every((p) => g(`${p.id}:promo`) === 'aceitavel');
  if (atmos.some((p) => g(`${p.id}:promo`) === null)) {
    return {
      verdict: 'pendente',
      text: 'pendente: falta o rótulo do atmosférico',
      pending: missingPromo,
      detail,
    };
  }
  const note = fbBad
    ? ` Atenção: o fallback ficou aceitável em ${fbOk} de ${promos.length} casos; ${FALLBACK_TEXT}.`
    : '';
  return atmosOk
    ? { verdict: 'aprovado', text: `aprovado (B1): estágio 6 segue.${note}`, pending: [], detail }
    : {
        verdict: 'aprovado',
        text: `segue com fallback (B2): estágio 6 segue só para destacáveis; atmosféricos usam a repintura de origem e destino com aviso.${note}`,
        pending: [],
        detail,
      };
}

/** Bloco C: pincel ou laço se confirma em ≥ 2 de 3 pedidos (sol editado, nuvem intacta, costura invisível). */
export function decideC(labels: Labels, ids: string[]): BlockDecision {
  const key = (id: string): string => `${id}:shape`;
  const l = (id: string, f: string): string | null => labels[key(id)]?.[f] ?? null;
  const ok = ids.filter(
    (id) =>
      l(id, 'edicao') === 'atendeu' &&
      l(id, 'nuvem') === 'intacta' &&
      l(id, 'costura') === 'invisivel',
  );
  const open = ids.filter((id) => ['edicao', 'nuvem', 'costura'].some((f) => l(id, f) === null));
  const detail = `${ok.length} de ${ids.length} pedidos com sol editado, nuvem intacta e costura invisível`;
  if (ok.length >= 2)
    return {
      verdict: 'aprovado',
      text: 'aprovado: pincel ou laço confirmado para itens sobrepostos (PV-14)',
      pending: [],
      detail,
    };
  if (ok.length + open.length < 2)
    return {
      verdict: 'reprovado',
      text: 'reprovado: o pincel ou laço não se confirma como alvo para itens sobrepostos',
      pending: [],
      detail,
    };
  return {
    verdict: 'pendente',
    text: 'pendente: faltam rótulos do bloco C',
    pending: open.map(key),
    detail,
  };
}
