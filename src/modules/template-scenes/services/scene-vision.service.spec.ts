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
  plan: { what_to_change: 'sol mais alaranjado', what_to_put: '' },
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
    texto_na_imagem: false,
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
      textInImage: false,
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
      { TEMPLATE_SCENE_VISION_MODEL: 'gpt-6-outro', TEMPLATE_SCENE_VISION_TIMEOUT_MS: '5000' },
    ).assess(input());
    expect(compare.mock.calls[0][0]).toMatchObject({ model: 'gpt-6-outro', timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: true, satisfied: 'parcial', costUsd: null });
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
    [verdict({ texto_na_imagem: 'sim' })],
  ])('JSON fora do esquema (%s) vira invalid_json e guarda o custo', async (text) => {
    const result = await build({ compare: ok(text) }).assess(input());
    expect(result).toMatchObject({ ok: false, reason: 'invalid_json', costUsd: 0.0004 });
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

  it('o cliente mock: sim por padrão, e os marcadores #juiz-nao, #juiz-parcial, #juiz-texto, #juiz-falha e #juiz-invalido', async () => {
    const service = build(new MockSceneVisionClient());
    expect(await service.assess(input())).toMatchObject({
      ok: true,
      satisfied: 'sim',
      seen: ['p1', 'p2'],
      notSeen: [],
      textInImage: false,
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
    expect(await service.assess(input(`x ${MOCK_VISION_MARKERS.text}`))).toMatchObject({
      satisfied: 'sim',
      textInImage: true,
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
      plan: { what_to_change: 'remover o coelho', what_to_put: 'gramado' },
      openItems: OPEN,
      hasBefore: true,
    });

    it('traz a mensagem literal e avisa que o plano pode estar errado', () => {
      expect(prompt).toContain('Mensagem do cliente: "tira o coelho".');
      expect(prompt).toContain('pode estar errado');
      expect(prompt).toContain('confira contra a MENSAGEM DO CLIENTE');
      expect(prompt).toContain('remover o coelho; gramado');
    });

    it('lista os itens em aberto com id, e pede só o que o juiz vê sobre o pedido', () => {
      expect(prompt).toContain('- p1: um rio no meio');
      expect(prompt).toContain('- p2: ovos no rodapé');
      expect(prompt).toContain('"vistos"');
      expect(prompt).toContain('"nao_vistos"');
      expect(prompt).toContain('"texto_na_imagem"');
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
