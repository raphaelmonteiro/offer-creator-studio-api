import { MockSceneVisionClient, MOCK_VISION_MARKERS } from './mock-scene-vision.client';

const client = new MockSceneVisionClient();
const compare = (prompt: string, correlationId = 'c') =>
  client.compare({ model: 'mock', prompt, after: Buffer.alloc(0), timeoutMs: 1000, correlationId });

describe('MockSceneVisionClient (o juiz simulado)', () => {
  it('responde sim e que viu todos os pedidos em aberto, sem custo', async () => {
    const result = await compare('Mensagem do cliente: "x".\n- p1: rio\n- p2: ovos');
    expect(JSON.parse(result.text)).toMatchObject({
      atendeu: 'sim',
      vistos: ['p1', 'p2'],
      nao_vistos: [],
      texto_extra: '',
    });
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it('#juiz-nao e #juiz-parcial não veem os pedidos; #juiz-texto-extra vê texto que ninguém pediu', async () => {
    const no = JSON.parse((await compare(`- p1: rio ${MOCK_VISION_MARKERS.notSatisfied}`)).text);
    expect(no).toMatchObject({ atendeu: 'nao', vistos: [], nao_vistos: ['p1'] });
    const partial = JSON.parse((await compare(`- p1: rio ${MOCK_VISION_MARKERS.partial}`)).text);
    expect(partial.atendeu).toBe('parcial');
    const extra = JSON.parse((await compare(`x ${MOCK_VISION_MARKERS.extraText}`)).text);
    expect(extra.texto_extra).toBe('PROMO');
  });

  describe('leitura do texto (D-51)', () => {
    const prompt = (marker = '') =>
      `x ${marker}\nLinha 1: “Promoção de Páscoa”\nLinha 2: “De R$ 19,90 por R$ 9,90”`;
    const lido = async (marker: string, key = 'v1') =>
      JSON.parse((await compare(prompt(marker), key)).text).texto_lido;

    it('sem marcador, lê as linhas certas', async () => {
      expect(await lido('')).toEqual([
        { pedido: 'Promoção de Páscoa', lido: 'Promoção de Páscoa' },
        { pedido: 'De R$ 19,90 por R$ 9,90', lido: 'De R$ 19,90 por R$ 9,90' },
      ]);
    });

    it('#juiz-texto-errado lê sem acento na primeira chamada e certo na segunda', async () => {
      expect((await lido(MOCK_VISION_MARKERS.textWrong, 'v2'))[0].lido).toBe('Promocao de Pascoa');
      expect((await lido(MOCK_VISION_MARKERS.textWrong, 'v2'))[0].lido).toBe('Promoção de Páscoa');
    });

    it('#juiz-texto-errado-2 erra nas duas, e #juiz-texto-vazio não acha o texto', async () => {
      expect((await lido(MOCK_VISION_MARKERS.textWrongTwice, 'v3'))[0].lido).toBe(
        'Promocao de Pascoa',
      );
      expect((await lido(MOCK_VISION_MARKERS.textWrongTwice, 'v3'))[0].lido).toBe(
        'Promocao de Pascoa',
      );
      expect((await lido(MOCK_VISION_MARKERS.textEmpty, 'v4'))[1].lido).toBe('');
    });
  });

  it('#juiz-invalido devolve texto que não é JSON, e #juiz-falha lança', async () => {
    expect((await compare('x #juiz-invalido')).text).toBe('não é json');
    await expect(compare('x #juiz-falha')).rejects.toThrow('juiz indisponível');
  });
});
