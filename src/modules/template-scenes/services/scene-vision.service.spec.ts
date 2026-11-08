import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockSceneVisionClient, MOCK_VISION_MARKERS } from '../providers/mock-scene-vision.client';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { buildVisionPrompt, SceneVisionService, visionCostUsd } from './scene-vision.service';

const JPEG = Buffer.from('jpeg');
const OPEN = [
  { id: 'p1', text: 'um rio no meio' },
  { id: 'p2', text: 'ovos no rodapé' },
];

const input = (message = 'deixa o sol mais alaranjado', extra: object = {}) => ({
  message,
  plan: { image: { change: 'sol mais alaranjado' } },
  openItems: OPEN,
  hasBefore: true,
  before: JPEG,
  after: JPEG,
  correlationId: 'corr-1',
  ...extra,
});

function build(client: SceneVisionClient, env: Record<string, string> = {}) {
  return new SceneVisionService(new ConfigService(env), client);
}

const verdict = (extra: object = {}) =>
  JSON.stringify({
    atendeu: 'sim',
    mudou: 'O sol ficou alaranjado.',
    vistos: ['p1'],
    nao_vistos: ['p2'],
    faltou: '',
    texto_lido: [],
    texto_extra: '',
    emenda: false,
    emenda_descricao: '',
    ...extra,
  });
const ok = (text: string, usage: object | null = { prompt_tokens: 3000, completion_tokens: 200 }) =>
  jest.fn().mockResolvedValue({ text, usage, requestId: 'req_v', latencyMs: 900 });

describe('SceneVisionService (o juiz)', () => {
  it('sucesso: devolve o que mudou, se atendeu, os itens vistos e não vistos, o texto, o custo e a requisição', async () => {
    const compare = ok(verdict());

    const result = await build({ compare }).assess(input());

    expect(result).toEqual({
      ok: true,
      changed: 'O sol ficou alaranjado.',
      satisfied: 'sim',
      seen: ['p1'],
      notSeen: ['p2'],
      missing: '',
      textLines: [],
      extraText: '',
      seam: false,
      seamDescription: '',
      costUsd: 0.0004,
      requestId: 'req_v',
      latencyMs: 900,
    });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][0]).toMatchObject({
      model: 'gpt-6-luna',
      before: JPEG,
      after: JPEG,
      timeoutMs: 20_000,
      correlationId: 'corr-1',
    });
  });

  it('usa o modelo e o tempo configurados', async () => {
    const compare = ok(verdict({ atendeu: 'parcial' }));
    const result = await build(
      { compare },
      { TEMPLATE_SCENE_VISION_MODEL: 'gpt-6-luna', TEMPLATE_SCENE_VISION_TIMEOUT_MS: '5000' },
    ).assess(input());
    expect(compare.mock.calls[0][0]).toMatchObject({ model: 'gpt-6-luna', timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: true, satisfied: 'parcial' });
  });

  it('ids desconhecidos saem, e o que foi visto não entra em não visto', async () => {
    const compare = ok(verdict({ vistos: ['p1', 'p9'], nao_vistos: ['p1', 'p2', 'p9'] }));
    const result = await build({ compare }).assess(input());
    expect(result).toMatchObject({ ok: true, seen: ['p1'], notSeen: ['p2'] });
  });

  it.each([
    ['texto solto'],
    [JSON.stringify({ mudou: 'x' })],
    [verdict({ atendeu: 'talvez' })],
    [verdict({ mudou: '  ' })],
    [verdict({ texto_lido: 'Promoção' })],
    [verdict({ texto_lido: [{ pedido: 'x' }] })],
    [verdict({ emenda: 'sim' })],
    [
      JSON.stringify({
        atendeu: 'sim',
        mudou: 'x',
        vistos: [],
        nao_vistos: [],
      }),
    ],
  ])('JSON fora do esquema (%s) vira invalid_json e guarda o custo', async (text) => {
    const result = await build({ compare: ok(text) }).assess(input());
    expect(result).toMatchObject({ ok: false, reason: 'invalid_json', costUsd: 0.0004 });
  });

  it('R11: modelo do juiz sem preço conferido não é chamado, o custo é zero conhecido e há erro no log', async () => {
    const compare = ok(verdict());
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const result = await build(
      { compare },
      { TEMPLATE_SCENE_VISION_MODEL: 'gpt-9-sem-preco' },
    ).assess(input());
    expect(compare).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'unpriced', costUsd: 0, requestId: null });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sem preço conferido'));
    error.mockRestore();
  });

  it('Juiz indisponível: erro e tempo esgotado viram ok false, sem custo conhecido, sem lançar', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('HTTP 500'));
    expect(await build({ compare: failing }).assess(input())).toEqual({
      ok: false,
      reason: 'error',
      costUsd: null,
      requestId: null,
    });
    const hanging = jest.fn().mockReturnValue(new Promise(() => undefined));
    const slow = await build(
      { compare: hanging },
      { TEMPLATE_SCENE_VISION_TIMEOUT_MS: '20' },
    ).assess(input());
    expect(slow).toMatchObject({ ok: false, reason: 'timeout', costUsd: null });
  });

  it('o cliente mock: sim por padrão, e os marcadores #juiz-nao, #juiz-parcial, #juiz-texto, #juiz-emenda, #juiz-falha e #juiz-invalido', async () => {
    const service = build(new MockSceneVisionClient());
    expect(await service.assess(input())).toMatchObject({
      ok: true,
      satisfied: 'sim',
      seen: ['p1', 'p2'],
      notSeen: [],
      extraText: '',
      costUsd: 0,
    });
    expect(await service.assess(input(`x ${MOCK_VISION_MARKERS.notSatisfied}`))).toMatchObject({
      satisfied: 'nao',
      seen: [],
      notSeen: ['p1', 'p2'],
    });
    expect(await service.assess(input(`x ${MOCK_VISION_MARKERS.partial}`))).toMatchObject({
      satisfied: 'parcial',
    });
    expect(await service.assess(input(`x ${MOCK_VISION_MARKERS.extraText}`))).toMatchObject({
      satisfied: 'sim',
      extraText: 'PROMO',
    });
    expect(await service.assess(input(`x ${MOCK_VISION_MARKERS.seam}`))).toMatchObject({
      satisfied: 'sim',
      seam: true,
      seamDescription: 'grupo sobre uma faixa de grama flutuando',
    });
    expect(await service.assess(input(`x ${MOCK_VISION_MARKERS.fail}`))).toMatchObject({
      ok: false,
      reason: 'error',
    });
    expect(await service.assess(input(`x ${MOCK_VISION_MARKERS.invalidJson}`))).toMatchObject({
      ok: false,
      reason: 'invalid_json',
    });
  });
});

describe('visionCostUsd e buildVisionPrompt', () => {
  it('conta entrada e saída pelo preço do gpt-6-luna; modelo sem preço ou sem usage dá null', () => {
    expect(
      visionCostUsd('gpt-6-luna', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }),
    ).toBe(0.6);
    expect(visionCostUsd('gpt-6-luna', null)).toBeNull();
    expect(visionCostUsd('gpt-6-luna', {})).toBeNull();
    expect(visionCostUsd('outro', { prompt_tokens: 10 })).toBeNull();
  });

  it('com detail high a entrada é maior e o mesmo cálculo conta o cache de entrada', () => {
    expect(
      visionCostUsd('gpt-6-luna', {
        prompt_tokens: 3000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 2000 },
      }),
    ).toBe(0.00022);
  });

  describe('Plano errado: o prompt manda conferir contra a mensagem do cliente', () => {
    const prompt = buildVisionPrompt({
      message: 'tira\n o  coelho',
      plan: { image: { change: 'remover o coelho; gramado' } },
      openItems: OPEN,
      hasBefore: true,
    });

    it('traz a mensagem literal e avisa que o plano pode estar errado', () => {
      expect(prompt).toContain('Mensagem do cliente: "tira o coelho".');
      expect(prompt).toContain('pode estar errado');
      expect(prompt).toContain('confira contra a MENSAGEM DO CLIENTE');
      expect(prompt).toContain('remover o coelho; gramado');
    });

    it('Juiz não cobra o ano de contexto: o prompt avisa que ano citado é contexto, e pergunta de emenda', () => {
      const withYear = buildVisionPrompt({
        message: 'template de pascoa para 2027',
        plan: { image: { change: 'criar o template; ovos e um coelho' } },
        openItems: [],
        hasBefore: false,
      });
      expect(withYear).toContain('Ano, data ou número citado na mensagem do cliente é contexto');
      expect(withYear).toContain('não cobre como faltando');
      expect(withYear).toContain('"emenda"');
      expect(withYear).toContain('objeto ou grupo de objetos flutuando');
      expect(withYear).toContain('"emenda" não muda "atendeu"');
    });

    it('lista os itens em aberto com id, e pede só o que o juiz vê sobre o pedido', () => {
      expect(prompt).toContain('- p1: um rio no meio');
      expect(prompt).toContain('- p2: ovos no rodapé');
      expect(prompt).toContain('"vistos"');
      expect(prompt).toContain('"nao_vistos"');
      expect(prompt).toContain('"texto_lido"');
      expect(prompt).toContain('"texto_extra"');
      expect(prompt).toContain('"faltou"');
      expect(prompt).not.toContain('texto_na_imagem');
      expect(prompt).toContain('cujo RESULTADO você VÊ');
      expect(prompt).toContain('num pedido de tirar algo, o item não aparece mais');
      expect(prompt).toContain('Não afirme nada sobre o resto da imagem');
      expect(prompt).toContain('ANTES');
    });

    it('na primeira imagem só há DEPOIS, e sem itens em aberto diz nenhum', () => {
      const first = buildVisionPrompt({
        message: 'campo verde',
        plan: {},
        openItems: [],
        hasBefore: false,
      });
      expect(first).toContain('só há a imagem DEPOIS');
      expect(first).not.toContain('a primeira imagem é ANTES');
      expect(first).toContain('em aberto (id: texto):\nnenhum');
      expect(first).toContain('sem plano');
    });
  });
});

describe('Juiz com leitura do texto (D-51)', () => {
  const lines = ['Promoção de Páscoa', 'De R$ 19,90 por R$ 9,90'];
  const asked = { expectedText: lines, hasCrop: true, crop: JPEG };
  const reading = (lido: string[], extra: object = {}) =>
    ok(
      verdict({
        texto_lido: lines.map((pedido, i) => ({ pedido, lido: lido[i] })),
        ...extra,
      }),
    );

  it('Texto certo: o código compara e todas as linhas batem; o recorte vai como imagem a mais', async () => {
    const compare = reading(lines);
    const result = await build({ compare }).assess(input('x', asked));
    expect(result).toMatchObject({
      ok: true,
      textLines: [
        { asked: lines[0], read: lines[0], ok: true },
        { asked: lines[1], read: lines[1], ok: true },
      ],
    });
    expect(compare.mock.calls[0][0].crop).toBe(JPEG);
    expect(compare.mock.calls[0][0].prompt).toContain('Linha 1: “Promoção de Páscoa”');
    expect(compare.mock.calls[0][0].prompt).toContain('A última imagem é o recorte da região');
  });

  it('Maiúsculas contam: "PROMOÇÃO DE PÁSCOA" não é igual a "Promoção de Páscoa"', async () => {
    const result = await build({ compare: reading(['PROMOÇÃO DE PÁSCOA', lines[1]]) }).assess(
      input('x', asked),
    );
    expect(result).toMatchObject({ textLines: [{ ok: false }, { ok: true }] });
  });

  it('Acento, vírgula e R$ contam; espaço repetido e aspas tipográficas não', async () => {
    const result = await build({
      compare: reading(['Promocao de Pascoa', 'De  R$ 19.90 por R$ 9,90']),
    }).assess(input('x', asked));
    expect(result).toMatchObject({
      textLines: [{ ok: false }, { ok: false, read: 'De  R$ 19.90 por R$ 9,90' }],
    });
    const spaced = await build({
      compare: reading(['Promoção  de Páscoa', 'De R$ 19,90 por R$ 9,90']),
    }).assess(input('x', asked));
    expect(spaced).toMatchObject({ textLines: [{ ok: true }, { ok: true }] });
  });

  it('Texto não encontrado: lido vazio é erro', async () => {
    const result = await build({ compare: reading(['', lines[1]]) }).assess(input('x', asked));
    expect(result).toMatchObject({ textLines: [{ read: '', ok: false }, { ok: true }] });
  });

  it('Texto que ninguém pediu: texto_extra e faltou voltam, com os limites', async () => {
    const result = await build({
      compare: reading(lines, { texto_extra: 'PROMO'.repeat(40), faltou: 'a placa'.repeat(40) }),
    }).assess(input('x', asked));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.extraText).toHaveLength(120);
    expect(result.ok && result.missing).toHaveLength(160);
  });

  it('com texto esperado, a falta de texto_lido invalida a saída; sem texto esperado, não precisa', async () => {
    const raw = JSON.parse(verdict());
    delete raw.texto_lido;
    const without = JSON.stringify(raw);
    expect(await build({ compare: ok(without) }).assess(input('x', asked))).toMatchObject({
      ok: false,
      reason: 'invalid_json',
    });
    expect(await build({ compare: ok(without) }).assess(input('x'))).toMatchObject({ ok: true });
  });

  it('Juiz indisponível com texto pedido: falha de rede vira ok false, sem lançar', async () => {
    const compare = jest.fn().mockRejectedValue(new Error('x'));
    expect(await build({ compare }).assess(input('x', asked))).toMatchObject({
      ok: false,
      reason: 'error',
    });
  });
});
