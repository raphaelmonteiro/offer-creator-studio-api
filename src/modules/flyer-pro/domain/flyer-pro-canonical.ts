/** O JSON com as chaves de objeto em ordem, para comparar valores jsonb sem depender da ordem em que o banco os devolve. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Igual pela comparação canônica; nulo e ausente valem o mesmo. */
export const canonicallyEqual = (a: unknown, b: unknown): boolean =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);
