/**
 * O instante do `updatedAfter` como o Postgres o lê sem ambiguidade: valor sem fuso (ou só a data) é UTC, não o fuso da
 * sessão do banco (A-12). Quem tem fuso (`Z`, `+00:00`, `-03`) segue como veio. O texto já passou pelo DTO (ISO 8601).
 */
export function utcInstantOf(text: string): string {
  const value = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
  const hasZone = /(Z|[+-]\d{2}(:?\d{2})?)$/i.test(value.slice(10));
  return hasZone ? value : `${value}Z`;
}
