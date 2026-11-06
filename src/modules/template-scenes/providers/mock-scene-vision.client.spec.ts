import { MockSceneVisionClient, MOCK_VISION_MARKERS } from './mock-scene-vision.client';

const compare = (prompt: string) =>
  new MockSceneVisionClient().compare({
    model: 'mock',
    prompt,
    after: Buffer.alloc(0),
    timeoutMs: 1000,
    correlationId: 'c',
  });

describe('MockSceneVisionClient (o juiz simulado)', () => {
  it('responde sim e que viu todos os pedidos em aberto, sem custo', async () => {
    const result = await compare('Mensagem do cliente: "x".\n- p1: rio\n- p2: ovos');
    expect(JSON.parse(result.text)).toMatchObject({
      atendeu: 'sim',
      vistos: ['p1', 'p2'],
      nao_vistos: [],
      texto_na_imagem: false,
    });
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it('#juiz-nao e #juiz-parcial não veem os pedidos; #juiz-texto vê texto', async () => {
    const no = JSON.parse((await compare(`- p1: rio ${MOCK_VISION_MARKERS.notSatisfied}`)).text);
    expect(no).toMatchObject({ atendeu: 'nao', vistos: [], nao_vistos: ['p1'] });
    const partial = JSON.parse((await compare(`- p1: rio ${MOCK_VISION_MARKERS.partial}`)).text);
    expect(partial.atendeu).toBe('parcial');
    const text = JSON.parse((await compare(`x ${MOCK_VISION_MARKERS.text}`)).text);
    expect(text.texto_na_imagem).toBe(true);
  });

  it('#juiz-invalido devolve texto que não é JSON, e #juiz-falha lança', async () => {
    expect((await compare('x #juiz-invalido')).text).toBe('não é json');
    await expect(compare('x #juiz-falha')).rejects.toThrow('juiz indisponível');
  });
});
