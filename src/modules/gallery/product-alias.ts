/**
 * "Nomes" de uma imagem da galeria: os nomes de produto (como vieram da
 * planilha) para os quais o usuário já escolheu esta foto. Guardados em
 * `metadata.aliases`, ao lado do bloco EAN, e consultados pela resolução do
 * encarte antes da busca por nome com IA.
 *
 * Um nome pode apontar para VÁRIAS fotos (embalagens diferentes por época):
 * todas entram como candidatas e o score híbrido ranqueia.
 */

export interface ProductAlias {
  /** Nome como veio na lista do encarte. */
  name: string;
  /** Chave de busca: `productAliasKey(name)`. */
  key: string;
  /** Última vez que esta foto foi escolhida para este nome. */
  chosenAt: string;
}

/** Teto de nomes por imagem: uma foto genérica pode servir a muitos, não a infinitos. */
export const PRODUCT_ALIAS_MAX = 50;

/**
 * Chave do nome: maiúsculas, sem acento, sem pontuação, espaços colapsados.
 * Mantém os tokens de quantidade ("LING TOSCANA SEARA KG"), que distinguem
 * produtos. "Ling  Toscana Seara Kg " e "LING TOSCANA SEARA KG" dão a mesma chave.
 */
export function productAliasKey(name: string | null | undefined): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export function readProductAliases(
  metadata: Record<string, unknown> | null | undefined,
): ProductAlias[] {
  const raw = metadata?.aliases;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is ProductAlias =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as ProductAlias).key === 'string' &&
      typeof (a as ProductAlias).name === 'string',
  );
}

/**
 * Acrescenta (ou renova) o nome na lista da imagem. Nome já presente só tem o
 * `chosenAt` atualizado; passando do teto, o mais antigo sai.
 */
export function addProductAlias(
  metadata: Record<string, unknown> | null | undefined,
  name: string,
  now: string = new Date().toISOString(),
): { metadata: Record<string, unknown>; key: string; added: boolean } | null {
  const key = productAliasKey(name);
  if (!key) return null;

  const current = readProductAliases(metadata);
  const existing = current.find((a) => a.key === key);
  const others = current.filter((a) => a.key !== key);
  const next: ProductAlias[] = [...others, { name: name.trim().slice(0, 200), key, chosenAt: now }];
  next.sort((a, b) => a.chosenAt.localeCompare(b.chosenAt));
  const trimmed = next.slice(Math.max(0, next.length - PRODUCT_ALIAS_MAX));

  return {
    metadata: { ...(metadata ?? {}), aliases: trimmed },
    key,
    added: !existing,
  };
}
