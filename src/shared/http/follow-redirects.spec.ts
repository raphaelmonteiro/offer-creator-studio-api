import {
  fetchFollowingRedirects,
  RedirectLimitError,
  RedirectLocationError,
} from './follow-redirects';

const signal = new AbortController().signal;
const redirect = (location: string | null, status = 302) =>
  new Response(null, { status, headers: location ? { location } : {} });
const ok = () => new Response('corpo', { status: 200 });

/** `fetch` que responde pela lista, uma resposta por chamada, e guarda as URLs pedidas. */
function scripted(responses: Response[]) {
  const asked: string[] = [];
  const fetch = jest.fn(async (url: string) => {
    asked.push(url);
    return responses[asked.length - 1];
  });
  return { fetch, asked };
}

const follow = (start: string, fetch: jest.Mock, checkUrl = jest.fn(), maxRedirects = 3) =>
  fetchFollowingRedirects(start, { fetch, signal, maxRedirects, checkUrl });

describe('fetchFollowingRedirects', () => {
  it('sem redirecionamento: devolve a resposta e confere só o primeiro endereço', async () => {
    const { fetch } = scripted([ok()]);
    const checkUrl = jest.fn();

    const res = await follow('https://a.exemplo.com/x.jpg', fetch, checkUrl);

    expect(res.status).toBe(200);
    expect(checkUrl.mock.calls).toEqual([['https://a.exemplo.com/x.jpg']]);
    expect(fetch).toHaveBeenCalledWith('https://a.exemplo.com/x.jpg', {
      signal,
      redirect: 'manual',
    });
  });

  it('Três saltos e o quarto: segue 3 e recusa o 4º com RedirectLimitError, sem pedir um 5º', async () => {
    const hops = ['/b', '/c', '/d', '/e'];
    const { fetch, asked } = scripted(hops.map((to) => redirect(to)));

    await expect(follow('https://a.exemplo.com/a', fetch)).rejects.toThrow(
      new RedirectLimitError(3),
    );

    expect(asked).toEqual([
      'https://a.exemplo.com/a',
      'https://a.exemplo.com/b',
      'https://a.exemplo.com/c',
      'https://a.exemplo.com/d',
    ]);
  });

  it('três redirecionamentos até a foto: baixa', async () => {
    const { fetch, asked } = scripted([redirect('/b'), redirect('/c'), redirect('/d'), ok()]);

    const res = await follow('https://a.exemplo.com/a', fetch);

    expect(res.status).toBe(200);
    expect(asked).toHaveLength(4);
  });

  it('cada destino passa por checkUrl antes de ser pedido; recusado, nenhuma requisição sai para ele', async () => {
    const { fetch, asked } = scripted([redirect('http://10.0.0.5/x.jpg')]);
    const checkUrl = jest.fn((url: string) => {
      if (url.includes('10.0.0.5')) throw new Error('recusado');
    });

    await expect(follow('https://www.extrabom.com.br/img/x.jpg', fetch, checkUrl)).rejects.toThrow(
      'recusado',
    );

    expect(asked).toEqual(['https://www.extrabom.com.br/img/x.jpg']);
    expect(checkUrl.mock.calls.map(([url]) => url)).toEqual([
      'https://www.extrabom.com.br/img/x.jpg',
      'http://10.0.0.5/x.jpg',
    ]);
  });

  it('o primeiro endereço recusado não gera requisição', async () => {
    const { fetch } = scripted([ok()]);
    const checkUrl = jest.fn(() => {
      throw new Error('fora da lista');
    });

    await expect(follow('ftp://exemplo.com/x.jpg', fetch, checkUrl)).rejects.toThrow(
      'fora da lista',
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it('Location relativo é resolvido contra o endereço atual; 301, 303, 307 e 308 também redirecionam', async () => {
    const { fetch, asked } = scripted([
      redirect('/img/b.jpg', 301),
      redirect('c.jpg', 303),
      redirect('//cdn.exemplo.com/d.jpg', 307),
      redirect('https://e.exemplo.com/e.jpg', 308),
      ok(),
    ]);

    await follow('https://a.exemplo.com/img/a.jpg', fetch, jest.fn(), 4);

    expect(asked).toEqual([
      'https://a.exemplo.com/img/a.jpg',
      'https://a.exemplo.com/img/b.jpg',
      'https://a.exemplo.com/img/c.jpg',
      'https://cdn.exemplo.com/d.jpg',
      'https://e.exemplo.com/e.jpg',
    ]);
  });

  it('redirecionamento sem Location: RedirectLocationError com o status', async () => {
    const { fetch } = scripted([redirect(null, 302)]);

    await expect(follow('https://a.exemplo.com/a', fetch)).rejects.toThrow(
      new RedirectLocationError(302),
    );
  });

  it('o corpo da resposta de redirecionamento é cancelado, sem esperar a falha do cancelamento', async () => {
    const cancel = jest.fn().mockRejectedValue(new Error('já fechado'));
    const body = { cancel } as unknown as ReadableStream;
    const first = redirect('/b');
    Object.defineProperty(first, 'body', { value: body });
    const { fetch } = scripted([first, ok()]);

    const res = await follow('https://a.exemplo.com/a', fetch);

    expect(res.status).toBe(200);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('status que não é redirecionamento (404, 304) volta como veio', async () => {
    const { fetch } = scripted([new Response(null, { status: 404 })]);

    expect((await follow('https://a.exemplo.com/a', fetch)).status).toBe(404);
  });
});
