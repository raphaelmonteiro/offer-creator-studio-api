import { ConfigService } from '@nestjs/config';
import { MockSceneVisionClient, MOCK_VISION_MARKERS } from '../providers/mock-scene-vision.client';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { buildVisionPrompt, SceneVisionService, visionCostUsd } from './scene-vision.service';

const PNG = Buffer.from('png');

const input = (request = 'deixa o sol mais alaranjado') => ({
  request,
  before: PNG,
  after: PNG,
  correlationId: 'corr-1',
});

function build(client: SceneVisionClient, env: Record<string, string> = {}) {
  return new SceneVisionService(new ConfigService(env), client);
}

const ok = (text: string, usage: object | null = { prompt_tokens: 1000, completion_tokens: 200 }) =>
  jest.fn().mockResolvedValue({ text, usage, requestId: 'req_v', latencyMs: 900 });

describe('SceneVisionService', () => {
  it('sucesso: devolve o que mudou, se atendeu, custo e requisição', async () => {
    const compare = ok('{"mudou":"O sol ficou alaranjado.","atendeu":"sim"}');

    const result = await build({ compare }).assess(input());

    expect(result).toEqual({
      ok: true,
      changed: 'O sol ficou alaranjado.',
      satisfied: 'sim',
      costUsd: 0.0002,
      requestId: 'req_v',
      latencyMs: 900,
    });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][0]).toMatchObject({
      model: 'gpt-6-luna',
      before: PNG,
      after: PNG,
      timeoutMs: 20_000,
      correlationId: 'corr-1',
    });
    expect(compare.mock.calls[0][0].prompt).toContain('"deixa o sol mais alaranjado"');
  });

  it('usa o modelo e o tempo configurados', async () => {
    const compare = ok('{"mudou":"x","atendeu":"parcial"}');
    const result = await build(
      { compare },
      { TEMPLATE_SCENE_VISION_MODEL: 'gpt-6-outro', TEMPLATE_SCENE_VISION_TIMEOUT_MS: '5000' },
    ).assess(input());
    expect(compare.mock.calls[0][0]).toMatchObject({ model: 'gpt-6-outro', timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: true, satisfied: 'parcial', costUsd: null });
  });

  it.each([
    ['texto solto'],
    ['{"mudou":"x"}'],
    ['{"mudou":"x","atendeu":"talvez"}'],
    ['{"mudou":"","atendeu":"sim"}'],
    ['{"mudou":3,"atendeu":"sim"}'],
    [''],
  ])('JSON fora do esquema (%j): não vale, mas o custo já cobrado fica', async (text) => {
    const result = await build({ compare: ok(text) }).assess(input());
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_json',
      costUsd: 0.0002,
      requestId: 'req_v',
    });
  });

  it('cliente que falha: ok false, sem lançar', async () => {
    const compare = jest.fn().mockRejectedValue(new Error('503'));
    expect(await build({ compare }).assess(input())).toEqual({
      ok: false,
      reason: 'error',
      costUsd: null,
      requestId: null,
    });
  });

  it('passou do tempo máximo: ok false com reason timeout', async () => {
    jest.useFakeTimers();
    try {
      const compare = jest.fn(() => new Promise<never>(() => undefined));
      const pending = build({ compare }, { TEMPLATE_SCENE_VISION_TIMEOUT_MS: '20000' }).assess(
        input(),
      );
      await jest.advanceTimersByTimeAsync(20_001);
      expect(await pending).toEqual({
        ok: false,
        reason: 'timeout',
        costUsd: null,
        requestId: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('o cliente mock responde sem custo e simula falha e JSON inválido', async () => {
    const service = build(new MockSceneVisionClient());
    expect(await service.assess(input())).toMatchObject({
      ok: true,
      satisfied: 'sim',
      costUsd: null,
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

  it('o pedido entra literal, sem quebras de linha', () => {
    const prompt = buildVisionPrompt('deixa\n o   sol  laranja');
    expect(prompt).toContain('"deixa o sol laranja"');
    expect(prompt).toContain('"atendeu"');
  });
});
