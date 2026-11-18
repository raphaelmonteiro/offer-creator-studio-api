/**
 * A chamada contra o relógio: devolve o resultado dela ou `'timeout'` quando `ms` passa antes; o timer sai quando a chamada
 * termina (nada fica pendurado no processo). Passado o prazo, uma rejeição tardia da chamada é absorvida pelo `race`.
 */
export async function withTimeout<T>(call: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([call, expired]);
  } finally {
    clearTimeout(timer);
  }
}
