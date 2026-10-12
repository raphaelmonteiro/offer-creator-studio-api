/**
 * Preço por extenso em pt-BR (puro): "24,90" → "vinte e quatro reais e noventa
 * centavos". O diretor F1 (change video-formatos-personagem, D6) exige preços
 * SEMPRE por extenso na fala; o roteiro mock e os testes usam esta função — o
 * diretor real recebe a instrução e é validado pelos mesmos testes de forma.
 * Cobre 0 a 999.999 reais, o suficiente para qualquer oferta de varejo.
 */

const UNIDADES = [
  'zero',
  'um',
  'dois',
  'três',
  'quatro',
  'cinco',
  'seis',
  'sete',
  'oito',
  'nove',
  'dez',
  'onze',
  'doze',
  'treze',
  'quatorze',
  'quinze',
  'dezesseis',
  'dezessete',
  'dezoito',
  'dezenove',
];
const DEZENAS = [
  '',
  '',
  'vinte',
  'trinta',
  'quarenta',
  'cinquenta',
  'sessenta',
  'setenta',
  'oitenta',
  'noventa',
];
const CENTENAS = [
  '',
  'cento',
  'duzentos',
  'trezentos',
  'quatrocentos',
  'quinhentos',
  'seiscentos',
  'setecentos',
  'oitocentos',
  'novecentos',
];

/** 0..999 por extenso (sem "mil"); 100 exato é "cem". */
function centenasPorExtenso(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const parts: string[] = [];
  if (c > 0) parts.push(CENTENAS[c]);
  if (resto > 0) {
    if (resto < 20) parts.push(UNIDADES[resto]);
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      parts.push(u > 0 ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d]);
    }
  }
  return parts.join(' e ');
}

/** Inteiro 0..999.999 por extenso. */
export function numeroPorExtenso(n: number): string {
  const value = Math.max(0, Math.min(999_999, Math.floor(n)));
  if (value < 1000) return centenasPorExtenso(value) || 'zero';
  const milhares = Math.floor(value / 1000);
  const resto = value % 1000;
  const prefix = milhares === 1 ? 'mil' : `${centenasPorExtenso(milhares)} mil`;
  if (resto === 0) return prefix;
  // "mil e cem", "dois mil e vinte"; sem "e" quando o resto tem centena não redonda ("mil duzentos e dez")
  const joiner = resto < 100 || resto % 100 === 0 ? ' e ' : ' ';
  return `${prefix}${joiner}${centenasPorExtenso(resto)}`;
}

/** "R$ 1.299,90" | "24,90" | "0,79" | "24" → { reais, centavos } (null quando ilegível). */
export function parsePreco(price: string): { reais: number; centavos: number } | null {
  const text = (price ?? '').replace(/R\$/i, '').replace(/\s+/g, '').trim();
  if (!text) return null;
  const match = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const reais = Number(match[1].replace(/\./g, ''));
  const centavosRaw = match[2] ?? '0';
  const centavos = Number(centavosRaw.length === 1 ? `${centavosRaw}0` : centavosRaw);
  if (!Number.isFinite(reais) || !Number.isFinite(centavos)) return null;
  return { reais, centavos };
}

/**
 * Preço por extenso para a FALA: "vinte e quatro reais e noventa centavos",
 * "um real", "setenta e nove centavos", "mil duzentos e noventa e nove reais e
 * noventa centavos". Preço ilegível volta o texto original (nunca inventa).
 */
export function precoPorExtenso(price: string): string {
  const parsed = parsePreco(price);
  if (!parsed) return price.trim();
  const { reais, centavos } = parsed;
  const parts: string[] = [];
  if (reais > 0) parts.push(`${numeroPorExtenso(reais)} ${reais === 1 ? 'real' : 'reais'}`);
  if (centavos > 0) {
    parts.push(`${numeroPorExtenso(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`);
  }
  if (parts.length === 0) return 'zero reais';
  return parts.join(' e ');
}
