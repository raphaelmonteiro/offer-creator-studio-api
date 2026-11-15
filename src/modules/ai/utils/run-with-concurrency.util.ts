/**
 * Roda `worker` sobre cada item com no máximo `limit` execuções ao mesmo tempo, mantendo a ordem do resultado.
 * Na primeira falha nenhum item novo é iniciado (as execuções em andamento terminam) e o erro é repassado,
 * como o `Promise.all` que isto substitui.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;

  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}
