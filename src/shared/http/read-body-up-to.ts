/** O que a leitura pede de uma `Response`. */
export interface BodySource {
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Lê o corpo de uma resposta até `maxBytes`: passou do teto, cancela a leitura (o resto nunca é carregado) e devolve `null`.
 * Resposta sem stream (`body` nulo) é lida inteira por `arrayBuffer()` e confere o mesmo teto.
 */
export async function readBodyUpTo(response: BodySource, maxBytes: number): Promise<Buffer | null> {
  if (!response.body) {
    const all = Buffer.from(await response.arrayBuffer());
    return all.length > maxBytes ? null : all;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, total);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}
