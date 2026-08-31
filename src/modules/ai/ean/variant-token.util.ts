/**
 * Feature 14 — Fase 2-bis, camada 4: portão de token de variante.
 *
 * Marca + quantidade é chave de BLOCKING, nunca de decisão: 59,9% das chaves
 * `(marca, quantidade)` do dump brasileiro são compartilhadas por 2+ produtos.
 * O que decide é sempre o token de variante — `carioca` vs `preto`,
 * `integral` vs `parboilizado`, `ao leite` vs `algodão doce`.
 *
 * Regras (derivadas da pesquisa de resolução de entidades):
 *
 * 1. **Conflito rejeita.** Tokens diferentes do mesmo grupo mutuamente
 *    exclusivo nos dois lados ⇒ produtos diferentes.
 * 2. **Subespecificação rejeita.** Se um lado declara um discriminante e o
 *    outro não declara nenhum daquele grupo, o candidato não é identificável
 *    — exige-se *evidência positiva de identidade*, não apenas ausência de
 *    contradição. É o que separa "Feijão Caldo Nobre carioca" de uma linha da
 *    OFF que só diz "Feijão Caldo Nobre".
 * 3. **Exige token de conteúdo compartilhado.** Sem nenhuma sobreposição
 *    além da marca (que já foi usada no blocking), não há do que se agarrar.
 */

/** Grupos mutuamente exclusivos: dois tokens distintos do mesmo grupo ⇒ conflito. */
export const DISCRIMINATOR_GROUPS: Record<string, readonly string[]> = {
  tipoProduto: [
    'feijao',
    'arroz',
    'tempero',
    'condimento',
    'farinha',
    'acucar',
    'cafe',
    'oleo',
    'azeite',
    'vinagre',
    'macarrao',
    'biscoito',
    'bolacha',
    'chocolate',
    'iogurte',
    'leite',
    'queijo',
    'manteiga',
    'margarina',
    'suco',
    'refrigerante',
    'cerveja',
    'sabao',
    'detergente',
    'amaciante',
    'desinfetante',
    'agua sanitaria',
    'absorvente',
    'fralda',
    'papel higienico',
    'shampoo',
    'condicionador',
    'sabonete',
  ],
  variedade: [
    'carioca',
    'preto',
    'fradinho',
    'jalo',
    'rajado',
    'vermelho',
    'integral',
    'parboilizado',
    'arboreo',
    'carnaroli',
    'cateto',
    'polido',
    'branco',
    'refinado',
    'cristal',
    'mascavo',
    'demerara',
  ],
  sabor: [
    'morango',
    'pessego',
    'baunilha',
    'coco',
    'amendoim',
    'avela',
    'castanha',
    'maracuja',
    'limao',
    'uva',
    'laranja',
    'banana',
    'abacaxi',
    'manga',
    'ao leite',
    'meio amargo',
    'amargo',
    'algodao doce',
    'cookies',
    'trufado',
    'original',
    'tradicional',
  ],
  formato: [
    'espaguete',
    'parafuso',
    'penne',
    'talharim',
    'ninho',
    'concha',
    'gravatinha',
    'ave maria',
  ],
  // Classificação de grão — "tipo 1" e "tipo 2" são produtos distintos, e o
  // token isolado ('1'/'2') é descartado por contentTokens, então precisa
  // entrar como termo de duas palavras.
  classificacao: ['tipo 1', 'tipo 2', 'tipo1', 'tipo2'],
};

/** Palavras sem poder discriminante — não contam como sobreposição. */
const STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'com',
  'sem',
  'e',
  'em',
  'para',
  'por',
  'a',
  'o',
  'as',
  'os',
  'um',
  'uma',
  'no',
  'na',
  'ao',
  'aos',
  'tipo',
  'sabor',
  'kg',
  'g',
  'ml',
  'l',
  'un',
  'und',
  'unidade',
  'unidades',
  'pct',
  'pacote',
  'caixa',
  'lata',
  'garrafa',
  'premium',
  'classe',
  'novo',
  'nova',
  'linha',
]);

export function normalizeText(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens de conteúdo: sem stopword, sem número puro, com 3+ caracteres. */
export function contentTokens(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const token of normalizeText(raw).split(' ')) {
    if (!token || token.length < 3) continue;
    if (STOPWORDS.has(token)) continue;
    if (/^\d+%?$/.test(token)) continue;
    out.add(token);
  }
  return out;
}

/** Todos os termos, do mais longo para o mais curto — a ordem importa (ver abaixo). */
const ALL_TERMS: Array<{ group: string; term: string }> = Object.entries(DISCRIMINATOR_GROUPS)
  .flatMap(([group, terms]) => terms.map((term) => ({ group, term })))
  .sort((a, b) => b.term.length - a.term.length);

/**
 * Discriminantes presentes no texto, por grupo. Cobre termos de 1 e 2 palavras.
 *
 * Casa o termo MAIS LONGO primeiro e consome o trecho, senão termos se
 * canibalizam: `leite` (tipoProduto) casa dentro de `ao leite` (sabor), e um
 * chocolate "ao leite" passaria a exigir que o candidato declarasse um tipo de
 * produto lácteo — rejeitando candidatos legítimos pelo motivo errado.
 */
export function discriminatorsOf(raw: string | null | undefined): Record<string, Set<string>> {
  let text = ` ${normalizeText(raw)} `;
  const found: Record<string, Set<string>> = {};

  for (const { group, term } of ALL_TERMS) {
    const needle = ` ${term} `;
    if (text.includes(needle)) {
      (found[group] ??= new Set()).add(term);
      // Deixa um separador no lugar para não colar as palavras vizinhas.
      text = text.split(needle).join('  ');
    }
  }
  return found;
}

export interface VariantGateResult {
  pass: boolean;
  reason: 'ok' | 'conflito-de-variante' | 'candidato-subespecificado' | 'sem-token-compartilhado';
  conflictingGroup?: string;
  sharedTokens: string[];
}

/**
 * `expected` é o lado da galeria (título + variante + filename); `candidate` é
 * o `product_name` da OFF. A marca já foi consumida pelo blocking, então o que
 * importa aqui é exclusivamente o poder discriminante restante.
 */
export function variantGate(expected: string, candidate: string): VariantGateResult {
  const expectedDisc = discriminatorsOf(expected);
  const candidateDisc = discriminatorsOf(candidate);

  // Passada 1 — CONFLITO DURO. Os dois lados declaram algo do mesmo grupo e
  // não coincidem: contradição definitiva. É evidência mais forte que ausência,
  // por isso vem antes (e é o motivo mais útil para reportar).
  for (const [group, expectedTerms] of Object.entries(expectedDisc)) {
    const candidateTerms = candidateDisc[group];
    if (!candidateTerms || candidateTerms.size === 0) continue;

    const intersect = [...expectedTerms].filter((t) => candidateTerms.has(t));
    if (intersect.length === 0) {
      return {
        pass: false,
        reason: 'conflito-de-variante',
        conflictingGroup: group,
        sharedTokens: [],
      };
    }
  }

  // Passada 2 — SUBESPECIFICAÇÃO. A galeria declara um discriminante e o
  // candidato é omisso nesse grupo: não há evidência positiva de identidade.
  for (const [group] of Object.entries(expectedDisc)) {
    const candidateTerms = candidateDisc[group];
    if (!candidateTerms || candidateTerms.size === 0) {
      return {
        pass: false,
        reason: 'candidato-subespecificado',
        conflictingGroup: group,
        sharedTokens: [],
      };
    }
  }

  // Regra 3 — precisa sobrar alguma evidência positiva de identidade.
  const shared = [...contentTokens(expected)].filter((t) => contentTokens(candidate).has(t));
  if (shared.length === 0) {
    return { pass: false, reason: 'sem-token-compartilhado', sharedTokens: [] };
  }

  return { pass: true, reason: 'ok', sharedTokens: shared };
}

/**
 * Score de sobreposição usado pela regra da margem (camada 5). Jaccard sobre
 * tokens de conteúdo — determinístico, sem chamada externa.
 */
export function overlapScore(expected: string, candidate: string): number {
  const a = contentTokens(expected);
  const b = contentTokens(candidate);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Camada 4b — token RARO compartilhado.
 *
 * Frequência documental medida no dump brasileiro separa dois regimes com
 * clareza: `chocolate` 5,77%, `leite` 4,92%, `arroz` 1,71%, `feijao` 0,66%
 * contra `oreo` 0,117%, `rocher` 0,016%, `raffaello` 0,003%. O corte em 0,5%
 * fica no vale entre eles.
 *
 * Token comum é evidência NULA: o blocking já casou marca, o que implica a
 * categoria — "chocolate" compartilhado entre uma foto de chocolate e uma
 * linha de chocolate da mesma marca não informa nada. Só o token raro carrega
 * identidade de linha de produto.
 */
export const RARE_DF_RATIO = 0.005;

/**
 * Tokens da MARCA são excluídos de propósito: ela já foi consumida pelo
 * blocking, então concordar nela não é coincidência — é tautologia. É o
 * argumento de "u-probability dentro do bloco" da literatura de Fellegi-Sunter.
 */
export function sharedRareTokens(
  expected: string,
  candidate: string,
  documentFrequency: Map<string, number>,
  totalDocuments: number,
  brand: string | null | undefined,
): string[] {
  if (totalDocuments <= 0) return [];
  const brandTokens = contentTokens(brand);
  const a = contentTokens(expected);
  const b = contentTokens(candidate);

  const shared: string[] = [];
  for (const token of a) {
    if (!b.has(token) || brandTokens.has(token)) continue;
    const df = documentFrequency.get(token) ?? 0;
    if (df / totalDocuments < RARE_DF_RATIO) shared.push(token);
  }
  return shared;
}

/**
 * Assinatura de discriminantes, para a camada 5b. Duas imagens que resolvem
 * para o mesmo GTIN só são aceitáveis se descreverem o mesmo produto — várias
 * fotos do mesmo item são legítimas, produtos diferentes não.
 */
export function discriminatorSignature(raw: string | null | undefined): string {
  const disc = discriminatorsOf(raw);
  return Object.entries(disc)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, terms]) => `${group}:${[...terms].sort().join('+')}`)
    .join('|');
}

/**
 * Camada 4c — atributo discriminante não correspondido.
 *
 * Generaliza a regra de subespecificação para além dos grupos curados: se o
 * lado da galeria declara um token RARO que o candidato não tem, há um
 * atributo de identidade sem correspondência. É a ideia de "discriminative
 * attributes" (DiffXtract): o que distingue variações aparece no texto livre
 * do título, não em campo estruturado.
 *
 * Pega `Kit Kat Dark` vs `Kit Kat` e `Nestlé Prestígio Bombom` vs `Bombom
 * Nestlé Especialidades` sem precisar enumerar `dark` e `prestigio` à mão.
 *
 * Usa APENAS título + variante (extraídos da imagem), nunca o filename — este
 * carrega ruído de operador ("NOVO", "20_gratis", numeração de foto) que é
 * raro por construção e provocaria rejeição espúria.
 */
export function unmatchedRareTokens(
  expectedClean: string,
  candidate: string,
  documentFrequency: Map<string, number>,
  totalDocuments: number,
  brand: string | null | undefined,
): string[] {
  if (totalDocuments <= 0) return [];
  const brandTokens = contentTokens(brand);
  const candidateTokens = contentTokens(candidate);

  const unmatched: string[] = [];
  for (const token of contentTokens(expectedClean)) {
    if (brandTokens.has(token) || candidateTokens.has(token)) continue;
    const df = documentFrequency.get(token) ?? 0;
    if (df / totalDocuments < RARE_DF_RATIO) unmatched.push(token);
  }
  return unmatched;
}
