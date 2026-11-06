import { MockSceneVisionClient } from './mock-scene-vision.client';

const compare = (prompt: string) =>
  new MockSceneVisionClient().compare({
    model: 'mock',
    prompt,
    before: Buffer.alloc(0),
    after: Buffer.alloc(0),
    timeoutMs: 1000,
    correlationId: 'c',
  });

describe('MockSceneVisionClient', () => {
  it('responde que atendeu, sem custo', async () => {
    const result = await compare('Pedido: "deixa o sol laranja".');
    expect(JSON.parse(result.text)).toMatchObject({ atendeu: 'sim' });
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it('#visao-nao: responde que o pedido não foi atendido', async () => {
    const result = await compare('Pedido: "remova os ovos #visao-nao".');
    expect(JSON.parse(result.text)).toMatchObject({ atendeu: 'nao' });
  });

  it('#visao-invalida devolve texto que não é JSON, e #falha-visao lança', async () => {
    expect((await compare('x #visao-invalida')).text).toBe('não é json');
    await expect(compare('x #falha-visao')).rejects.toThrow('visão indisponível');
  });
});
