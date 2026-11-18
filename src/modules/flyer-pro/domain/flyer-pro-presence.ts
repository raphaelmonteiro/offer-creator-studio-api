/** Quando um campo do corpo conta como enviado, numa regra só para N1, N4 e N5: nem `undefined` nem `null`. */
export const isSent = (value: unknown): boolean => value !== undefined && value !== null;

/** Os campos pedidos que o corpo não traz (ausentes ou nulos), na ordem em que foram pedidos. */
export function missingFields(
  body: object | undefined | null,
  fields: readonly string[],
): string[] {
  const record = (body ?? {}) as Record<string, unknown>;
  return fields.filter((field) => !isSent(record[field]));
}
