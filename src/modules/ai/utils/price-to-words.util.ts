/**
 * Números e preços por extenso em pt-BR.
 *
 * Existe porque o TTS lê "19,90" mal (spike §4): a locução precisa receber
 * "dezenove e noventa". Função pura, sem IA — o modelo não é confiável para
 * isso e cada chamada custaria dinheiro à toa.
 */

const UNITS = [
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

const TENS = [
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

const HUNDREDS = [
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

/** Inteiro de 0 a 999.999 por extenso. */
export function integerToWordsPtBr(value: number): string {
  const n = Math.trunc(Math.abs(value));
  if (n < 20) return UNITS[n];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const rest = n % 10;
    return rest === 0 ? TENS[tens] : `${TENS[tens]} e ${UNITS[rest]}`;
  }
  if (n === 100) return 'cem';
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    return rest === 0 ? HUNDREDS[hundreds] : `${HUNDREDS[hundreds]} e ${integerToWordsPtBr(rest)}`;
  }
  if (n < 1_000_000) {
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    const prefix = thousands === 1 ? 'mil' : `${integerToWordsPtBr(thousands)} mil`;
    if (rest === 0) return prefix;
    // "mil e duzentos" (rest redondo) vs "mil duzentos e cinquenta"
    const connector = rest < 100 || rest % 100 === 0 ? ' e ' : ' ';
    return `${prefix}${connector}${integerToWordsPtBr(rest)}`;
  }
  // acima disso não é preço de encarte — devolve o número mesmo
  return String(n);
}

/**
 * Preço no ritmo em que o locutor de varejo fala: "dezenove e noventa",
 * "cinco reais", "cinquenta e nove e noventa e nove".
 *
 * Centavos zerados viram "<n> reais" (ou "um real"). Com centavos, o formato
 * curto "X e Y" é o que soa natural no rádio — a moeda fica subentendida.
 */
export function priceToWordsPtBr(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  // arredonda em centavos antes de separar, senão 19.999 vira "dezenove e cem"
  const cents = Math.round(value * 100);
  const reais = Math.floor(cents / 100);
  const centavos = cents % 100;

  if (centavos === 0) {
    if (reais === 0) return 'de graça';
    return reais === 1 ? 'um real' : `${integerToWordsPtBr(reais)} reais`;
  }
  if (reais === 0) {
    return centavos === 1 ? 'um centavo' : `${integerToWordsPtBr(centavos)} centavos`;
  }
  return `${integerToWordsPtBr(reais)} e ${integerToWordsPtBr(centavos)}`;
}

/**
 * Troca todo preço numérico de um texto pela versão por extenso.
 * Aceita "R$ 19,90", "19,90", "19.90" e "R$5".
 */
export function spellOutPricesPtBr(text: string): string {
  return text.replace(
    /R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:[.,](\d{1,2}))?|\b(\d+)[,](\d{2})\b/g,
    (
      match,
      reaisWithSymbol: string | undefined,
      centsWithSymbol: string | undefined,
      reaisPlain: string | undefined,
      centsPlain: string | undefined,
    ) => {
      const reaisRaw = reaisWithSymbol ?? reaisPlain;
      const centsRaw = centsWithSymbol ?? centsPlain;
      if (reaisRaw === undefined) return match;
      const reais = Number(reaisRaw.replace(/\./g, ''));
      if (!Number.isFinite(reais)) return match;
      const cents = centsRaw ? Number(centsRaw.padEnd(2, '0')) : 0;
      return priceToWordsPtBr(reais + cents / 100);
    },
  );
}
