import { readBodyUpTo } from './read-body-up-to';

/** Corpo em pedaços de `size` bytes, até `total`; `seen` conta os pedaços puxados e `cancelled` o cancelamento. */
function streamOf(total: number, size = 4) {
  const seen = { pulled: 0, cancelled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= total) return controller.close();
        const length = Math.min(size, total - sent);
        sent += length;
        seen.pulled += 1;
        controller.enqueue(new Uint8Array(length).fill(7));
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: { body, arrayBuffer: () => Promise.reject(new Error('sem stream')) }, seen };
}

describe('readBodyUpTo', () => {
  it('o teto exato passa: devolve todos os bytes', async () => {
    const { response, seen } = streamOf(10);

    const buffer = await readBodyUpTo(response, 10);

    expect(buffer).toHaveLength(10);
    expect(seen.cancelled).toBe(false);
  });

  it('um byte a mais para: devolve null e cancela a leitura sem puxar o resto', async () => {
    const { response, seen } = streamOf(1000);

    expect(await readBodyUpTo(response, 9)).toBeNull();

    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBe(3);
  });

  it('corpo vazio devolve um buffer vazio', async () => {
    expect(await readBodyUpTo(streamOf(0).response, 10)).toHaveLength(0);
  });

  it('sem stream: lê tudo por arrayBuffer e confere o mesmo teto', async () => {
    const bytes = (length: number) => ({
      body: null,
      arrayBuffer: async () => new Uint8Array(length).buffer,
    });

    expect(await readBodyUpTo(bytes(10), 10)).toHaveLength(10);
    expect(await readBodyUpTo(bytes(11), 10)).toBeNull();
  });

  it('falha ao cancelar não derruba a leitura que já passou do teto', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        throw new Error('soquete já fechado');
      },
    });

    expect(
      await readBodyUpTo({ body, arrayBuffer: async () => new ArrayBuffer(0) }, 10),
    ).toBeNull();
  });
});
