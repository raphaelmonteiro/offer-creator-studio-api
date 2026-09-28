import { normalizeBrand } from './gtin.util';

/** Dígitos do prefixo usados como chave: 789 + 4 dígitos da empresa. */
export const PREFIX_DIGITS = 7;

/**
 * Mínimo de GTINs observados no prefixo para ele poder vetar. Com poucos
 * exemplos o conjunto de marcas é incompleto e o veto viraria falso negativo.
 */
export const MIN_EVIDENCE = 3;

/**
 * Mapa prefixo de empresa GS1 → marcas observadas.
 *
 * O EAN-13 embute o prefixo da empresa que licenciou o código; um EAN da
 * Heinz não pode ser o de uma foto da Quero. Não existe base pública
 * prefixo→empresa, então o mapa é aprendido dos próprios dados (dump da OFF
 * e vínculos já verificados). O prefixo brasileiro tem tamanho variável; com
 * 7 dígitos, empresas menores dividem o mesmo balde — por isso o veto é "a
 * marca não está entre as observadas", nunca "é outra marca".
 */
export class Gs1PrefixMap {
  private readonly buckets = new Map<string, { brands: Set<string>; n: number }>();

  add(gtin: string, brand: string | null | undefined): void {
    const b = normalizeBrand(brand);
    const key = prefixOf(gtin);
    if (!b || !key) return;
    const bucket = this.buckets.get(key) ?? { brands: new Set<string>(), n: 0 };
    bucket.brands.add(b);
    bucket.n += 1;
    this.buckets.set(key, bucket);
  }

  get size(): number {
    return this.buckets.size;
  }

  /**
   * Devolve o motivo do veto, ou null. Prefixo desconhecido, evidência fraca
   * ou imagem sem marca nunca vetam.
   */
  veto(gtin: string, imageBrand: string | null | undefined): string | null {
    const key = prefixOf(gtin);
    const brand = normalizeBrand(imageBrand);
    if (!key || !brand) return null;
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.n < MIN_EVIDENCE) return null;
    for (const known of bucket.brands) {
      if (brandsCompatible(known, brand)) return null;
    }
    return `prefixo ${key} pertence a ${[...bucket.brands].slice(0, 4).join(', ')}`;
  }
}

/** Prefixo de 7 dígitos de um EAN-13 (GTIN-14 com zero à esquerda também). */
export function prefixOf(gtin: string): string | null {
  const digits = String(gtin ?? '').replace(/\D/g, '');
  const ean13 = digits.length === 14 && digits.startsWith('0') ? digits.slice(1) : digits;
  if (ean13.length !== 13) return null;
  // Faixas 02x/04x são códigos internos de loja (peso variável): sem empresa.
  if (/^0[24]/.test(ean13) || /^2/.test(ean13)) return null;
  return ean13.slice(0, PREFIX_DIGITS);
}

/**
 * "sadia" ~ "sadia s a", "matte leao" ~ "leao": compatíveis se todos os
 * tokens de uma estão na outra.
 */
export function brandsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = new Set(a.split(' ').filter((t) => t.length > 1));
  const tb = new Set(b.split(' ').filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return false;
  const [menor, maior] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of menor) if (!maior.has(t)) return false;
  return true;
}
