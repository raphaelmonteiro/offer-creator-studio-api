import { ConfigService } from '@nestjs/config';
import { DIRECTOR_JSON_SCHEMA } from '../domain/scene-director-schema';
import { DirectorScript, SceneDirectorClient } from '../providers/scene-director-client';
import { SceneDirectorService } from './scene-director.service';

const SCRIPT: DirectorScript = {
  message: 'tira o coelho',
  hasImage: true,
  marked: false,
  openRequests: [],
  layers: [],
  hasLogoAttachment: false,
};
const INPUT = {
  text: 'Cliente: tira o coelho',
  image: Buffer.from('jpeg'),
  script: SCRIPT,
  correlationId: 'corr-1',
};

const answer = (usage: object | null = { input_tokens: 2600, output_tokens: 350 }) => ({
  text: '{}',
  usage,
  requestId: 'req_dir',
  latencyMs: 4200,
});

function build(plan: jest.Mock, env: Record<string, string> = {}) {
  const client: SceneDirectorClient = { plan };
  return new SceneDirectorService(new ConfigService(env), client);
}

describe('SceneDirectorService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sucesso: chama o cliente com o modelo, as instruções, o schema e o tempo, sem previous_response_id', async () => {
    const plan = jest.fn().mockResolvedValue(answer());
    const result = await build(plan).run(INPUT);

    expect(result).toEqual({
      ok: true,
      text: '{}',
      costUsd: 0.000435,
      requestId: 'req_dir',
      latencyMs: 4200,
    });
    expect(plan).toHaveBeenCalledTimes(1);
    const call = plan.mock.calls[0][0];
    expect(call).not.toHaveProperty('previous_response_id');
    expect(call).toMatchObject({
      model: 'gpt-6-luna',
      text: 'Cliente: tira o coelho',
      jsonSchema: DIRECTOR_JSON_SCHEMA,
      timeoutMs: 20_000,
      correlationId: 'corr-1',
    });
    expect(call.instructions).toContain('diretor de arte');
    expect(call.image).toEqual(Buffer.from('jpeg'));
  });

  it('o custo conta o cache de entrada e a escrita em cache', async () => {
    const usage = {
      input_tokens: 12_600,
      input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 10_000 },
      output_tokens: 300,
    };
    const result = await build(jest.fn().mockResolvedValue(answer(usage))).run(INPUT);
    // 600 * 0,10 + 2000 * 0,01 + 10000 * 0,125 + 300 * 0,50 = 1480 / 1e6 * 1000 ... em USD
    expect(result).toMatchObject({ ok: true, costUsd: 0.00148 });
  });

  it('resposta sem usage: ok, com custo null (o consumer marca como desconhecido)', async () => {
    const result = await build(jest.fn().mockResolvedValue(answer(null))).run(INPUT);
    expect(result).toMatchObject({ ok: true, costUsd: null });
  });

  it('inválido (texto fora do schema) também volta ok: validar e refazer é do consumer', async () => {
    const plan = jest.fn().mockResolvedValue({ ...answer(), text: 'não é json' });
    expect(await build(plan).run(INPUT)).toMatchObject({ ok: true, text: 'não é json' });
  });

  it('tempo esgotado: ok false, sem nova chamada e custo desconhecido', async () => {
    const plan = jest.fn().mockReturnValue(new Promise(() => undefined));
    const result = await build(plan, { TEMPLATE_SCENE_DIRECTOR_TIMEOUT_MS: '20' }).run(INPUT);
    expect(result).toEqual({ ok: false, reason: 'timeout', costUsd: null, requestId: null });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('erro do provedor: ok false com reason error', async () => {
    const plan = jest.fn().mockRejectedValue(new Error('HTTP 500'));
    expect(await build(plan).run(INPUT)).toMatchObject({ ok: false, reason: 'error' });
  });

  it('insufficient_quota: reason quota, uma só requisição', async () => {
    const quota = Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' });
    const plan = jest.fn().mockRejectedValue(quota);
    expect(await build(plan).run(INPUT)).toMatchObject({ ok: false, reason: 'quota' });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('modelo pago sem preço conferido não é chamado, e o erro vai ao log', async () => {
    const plan = jest.fn();
    const result = await build(plan, { TEMPLATE_SCENE_DIRECTOR_MODEL: 'gpt-6-astra' }).run(INPUT);
    expect(result).toMatchObject({ ok: false, reason: 'unpriced' });
    expect(plan).not.toHaveBeenCalled();
  });

  it('tempo e modelo inválidos voltam ao padrão', () => {
    const service = build(jest.fn(), { TEMPLATE_SCENE_DIRECTOR_TIMEOUT_MS: 'abc' });
    expect(service.timeoutMs()).toBe(20_000);
    expect(service.model()).toBe('gpt-6-luna');
  });
});
