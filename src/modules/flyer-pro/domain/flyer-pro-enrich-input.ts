/**
 * Como o job lê os campos opcionais do item (A-22): ausente, `null` e texto só com espaços valem igual ("sem ele").
 * `strictNullChecks` está desligado no backend, então todo campo opcional passa por aqui antes de ir ao provedor.
 */

/** O texto aparado, ou `null` se o valor é ausente, `null`, não é texto ou só tem espaços. */
export function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A categoria que veio na planilha (`imported.rawCategory`), ou `null`. */
export const rawCategoryOf = (
  imported: Record<string, unknown> | null | undefined,
): string | null => textOrNull(imported?.rawCategory);

/** O nome que vai à busca de fotos: o da planilha (`sourceName`) quando há, senão o do item; nunca vazio. */
export const searchNameOf = (item: { name: string; sourceName?: string | null }): string =>
  textOrNull(item.sourceName) ?? item.name;
