/**
 * Feature 14 — utilitários compartilhados por todas as fontes de EAN
 * (Open Food Facts, Cosmos, decodificação local, entrada manual).
 *
 * Regra do spec: nenhum EAN entra na base sem passar pelo checksum GS1.
 * Isso descarta de saída código alucinado por LLM, digitação errada e o lixo
 * colaborativo da OFF (a base tem entradas como `00000022` com marca
 * "Coca-Cola" e nome "Farandole de madeleine").
 */

export type CanonicalUnit = 'g' | 'ml' | 'un' | 'm';

/**
 * Valida o dígito verificador GS1. Aceita GTIN-8, UPC-A (12), EAN-13 e
 * GTIN-14 — o mesmo conjunto que o `ProductMetadataSchema` já permite.
 *
 * O algoritmo: da direita para a esquerda (ignorando o dígito verificador),
 * multiplica alternadamente por 3 e 1; o verificador é o complemento da soma
 * para a próxima dezena.
 */
export function isValidGtin(raw: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(raw)) return false;

  const digits = raw.split('').map(Number);
  const check = digits.pop() as number;

  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += digits[i] * weight;
    weight = weight === 3 ? 1 : 3;
  }

  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Checksum válido NÃO basta para a OFF. A base tem entradas de teste cujo
 * dígito verificador fecha certo — `00000086` ("Vegan protein powder"),
 * `00002332` ("Contra Filé Mataboi", marca alemã, 5 litros de carne).
 *
 * Um GTIN de varejo real emitido pela GS1 não começa com uma sequência de
 * zeros (os 3 primeiros dígitos são o prefixo GS1 do país: 789/790 no Brasil,
 * outros para importados) e é EAN-13/GTIN-14, não GTIN-8 — este último existe
 * para embalagens minúsculas e é onde o lixo da OFF se concentra.
 *
 * Sem esse filtro, uma linha-lixo com marca real e quantidade comum
 * (`0000200375991 | SADIA | 200g`) casaria com uma foto legítima da galeria e
 * gravaria um EAN falso.
 */
export function isPlausibleRetailGtin(raw: string | null | undefined): boolean {
  const gtin = normalizeGtin(raw);
  if (!gtin) return false;
  if (gtin.length < 12) return false;
  if (/^00/.test(gtin)) return false;
  return true;
}

/** Remove tudo que não é dígito e devolve o GTIN se ele for válido. */
export function normalizeGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  // Um EAN-13 com zero à esquerda vira UPC-A e vice-versa; ambos são válidos
  // e devem casar entre si, então guardamos sem o zero de padding.
  const trimmed = digits.replace(/^0+(?=\d{8,})/, '');

  for (const candidate of [digits, trimmed]) {
    if (isValidGtin(candidate)) return candidate;
  }
  return null;
}

/**
 * Normaliza marca para comparação: minúscula, sem acento, sem pontuação.
 * Precisa bater com o `lower(unaccent(...))` usado no lado do Postgres.
 */
export function normalizeBrand(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Converte quantidade para unidade-base canônica, para que "5kg" e "5000g"
 * (ambos aparecem no metadata — a visão é instruída a NÃO converter) casem
 * entre si. Massa vira g, volume vira ml; contagem e comprimento passam
 * direto.
 */
export function canonicalQuantity(
  quantity: { value?: number | null; unit?: string | null } | null | undefined,
): { value: number; unit: CanonicalUnit } | null {
  const value = quantity?.value;
  if (!quantity || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const unit = String(quantity.unit ?? '').toLowerCase();
  switch (unit) {
    case 'kg':
      return { value: value * 1000, unit: 'g' };
    case 'g':
      return { value, unit: 'g' };
    case 'l':
      return { value: value * 1000, unit: 'ml' };
    case 'ml':
      return { value, unit: 'ml' };
    case 'un':
      return { value, unit: 'un' };
    case 'm':
      return { value, unit: 'm' };
    default:
      return null;
  }
}

/**
 * Interpreta o campo `quantity` da OFF, que é texto livre preenchido por
 * colaborador: "590 g", "1 L", "2 x 500 ml", "500ml", "1,5L".
 * Multipack ("2 x 500 ml") devolve o total (1000 ml), que é como a
 * quantidade líquida costuma aparecer na embalagem.
 */
export function parseFreeTextQuantity(
  raw: string | null | undefined,
): { value: number; unit: CanonicalUnit } | null {
  if (!raw) return null;
  const text = String(raw).toLowerCase().replace(/,/g, '.').trim();
  if (!text) return null;

  const multipack = text.match(
    /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml|cl|un|und|unidades?|m)\b/,
  );
  if (multipack) {
    const count = Number(multipack[1]);
    const each = Number(multipack[2]);
    const scaled = scaleUnit(each, multipack[3]);
    if (scaled && Number.isFinite(count) && count > 0) {
      return { value: scaled.value * count, unit: scaled.unit };
    }
  }

  const single = text.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|cl|un|und|unidades?|m)\b/);
  if (single) {
    return scaleUnit(Number(single[1]), single[2]);
  }

  return null;
}

function scaleUnit(value: number, unit: string): { value: number; unit: CanonicalUnit } | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  switch (unit) {
    case 'kg':
      return { value: value * 1000, unit: 'g' };
    case 'g':
      return { value, unit: 'g' };
    case 'l':
      return { value: value * 1000, unit: 'ml' };
    case 'cl':
      return { value: value * 10, unit: 'ml' };
    case 'ml':
      return { value, unit: 'ml' };
    case 'm':
      return { value, unit: 'm' };
    case 'un':
    case 'und':
    case 'unidade':
    case 'unidades':
      return { value, unit: 'un' };
    default:
      return null;
  }
}

/**
 * Duas quantidades casam se forem da mesma unidade-base e estiverem dentro de
 * 2% uma da outra — margem para arredondamento de embalagem (ex.: 1000g vs
 * 1kg declarado como 1000.0g, ou 355ml vs 350ml).
 */
export function quantityMatches(
  a: { value: number; unit: CanonicalUnit } | null,
  b: { value: number; unit: CanonicalUnit } | null,
): boolean {
  if (!a || !b) return false;
  if (a.unit !== b.unit) return false;
  const tolerance = Math.max(a.value, b.value) * 0.02;
  return Math.abs(a.value - b.value) <= tolerance;
}
