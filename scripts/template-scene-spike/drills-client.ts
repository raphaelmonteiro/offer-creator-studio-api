import { StopError } from './budget';
import type { StopCode } from './budget';
import { paidEdit, paidGenerate } from './calls';
import type { Services } from './calls';
import { createClient } from './client-factory';
import { loadConfig, loadPrices } from './config';
import { Drill, drillDir } from './drill-util';
import { FakeOpenAi, providerError } from './fake-openai';
import type { FakeOptions } from './fake-openai';
import { RealOpenAi } from './openai-client';
import { openSession } from './session';
import * as sharp from 'sharp';

function services(
  name: string,
  fake: FakeOptions,
  maxCallUsd = 3,
): Services & { fake: FakeOpenAi } {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  const client = new FakeOpenAi(fake);
  const session = openSession(drillDir(name), true, {
    budgetUsd: 100,
    initialReserveUsd: 2,
    maxCallUsd,
  });
  return { config, prices: loadPrices(), client, session, fake: client };
}

const gen = (svc: Services) =>
  paidGenerate(svc, { caseId: 'C1', block: 'F', step: 'generate', prompt: 'p', size: '1024x1024' });

async function crop(): Promise<Buffer> {
  const raw = { create: { width: 1024, height: 640, channels: 3 as const, background: '#336699' } };
  return sharp(raw).png().toBuffer();
}

async function edit(svc: Services, arm: 'mask' | 'markup'): Promise<unknown> {
  const image = await crop();
  const params = { prompt: 'p', size: '1024x640', image, [arm]: image };
  return paidEdit(svc, { caseId: 'A01', block: 'A', step: `edit_${arm}`, arm, params });
}

async function stopCode(fn: () => Promise<unknown>): Promise<StopCode | 'none'> {
  try {
    await fn();
    return 'none';
  } catch (e) {
    return e instanceof StopError ? e.code : 'none';
  }
}

async function terminal(d: Drill): Promise<void> {
  d.section('Critérios de parada: erros terminais (P2), sem retentativa');
  const quota = providerError(429, 'insufficient_quota', 'You exceeded your current quota');
  const q = services('quota', { inject: () => quota });
  d.check('quota: para na hora', (await stopCode(() => gen(q))) === 'quota');
  d.check(
    'quota: uma só chamada e erro no ledger',
    q.fake.calls === 1 && q.session.ledger.entries()[0].errorCode === 'insufficient_quota',
  );
  const auth = services('auth', { inject: () => providerError(401, 'invalid_api_key', 'bad key') });
  d.check('401: para', (await stopCode(() => gen(auth))) === 'auth');
  const model = services('model', {
    inject: () => providerError(404, 'model_not_found', 'no model'),
  });
  d.check('modelo inexistente: para', (await stopCode(() => gen(model))) === 'model');
}

async function refusals(d: Drill): Promise<void> {
  d.section('Critérios de parada: parâmetro recusado (P3)');
  const markup = services('markup', {
    inject: () => providerError(400, 'invalid_request', "Unknown parameter: 'markup'"),
  });
  await stopCode(() => edit(markup, 'markup'));
  d.check('1 recusa de markup não desliga o braço', !markup.session.budget.isMarkupDisabled());
  await stopCode(() => edit(markup, 'markup'));
  d.check(
    '2 recusas seguidas desligam só o braço markup',
    markup.session.budget.isMarkupDisabled(),
  );
  const mask = services('mask', {
    inject: () => providerError(400, 'invalid_request', "Invalid value for 'mask'"),
  });
  await stopCode(() => edit(mask, 'mask'));
  d.check(
    '2 recusas de mask param o spike',
    (await stopCode(() => edit(mask, 'mask'))) === 'mask_refused',
  );
}

async function failures(d: Drill): Promise<void> {
  d.section('Critérios de parada: falhas seguidas (P4) e custo anômalo (P5)');
  const boom = services('falhas', { inject: () => providerError(500, 'server_error', 'boom') });
  const codes: string[] = [];
  for (let i = 0; i < 5; i += 1) codes.push(await stopCode(() => gen(boom)));
  d.check('5 falhas seguidas param na quinta', codes.join() === 'none,none,none,none,failures');
  const flaky = services('intermitente', {
    inject: (n) => (n % 5 === 0 ? null : providerError(500, 'server_error', 'boom')),
  });
  const flakyCodes: string[] = [];
  for (let i = 0; i < 10; i += 1) flakyCodes.push(await stopCode(() => gen(flaky)));
  d.check(
    'um sucesso zera a contagem',
    flakyCodes.every((c) => c === 'none'),
  );
  const costly = services('anomalo', {}, 0.001);
  d.check(
    'custo acima de SPIKE_MAX_CALL_USD para',
    (await stopCode(() => gen(costly))) === 'anomalous_cost',
  );
  d.check('a chamada anômala fica no ledger', costly.session.ledger.entries().length === 1);
}

async function factory(d: Drill): Promise<void> {
  d.section('Cliente: dry-run sem rede, chave ausente, mask e markup juntos');
  const realFetch = globalThis.fetch;
  let touched = false;
  globalThis.fetch = (() => {
    touched = true;
    throw new Error('rede proibida no dry-run');
  }) as typeof fetch;
  try {
    const cfg = loadConfig({ OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv);
    const svc = services('dry', {});
    await gen(svc);
    d.check(
      'sem --confirm-spend o cliente é o falso',
      createClient(cfg, false) instanceof FakeOpenAi,
    );
    d.check('nenhuma requisição saiu', !touched);
    svc.session.lock.release();
  } finally {
    globalThis.fetch = realFetch;
  }
  const empty = loadConfig({ OPENAI_API_KEY: '' } as NodeJS.ProcessEnv);
  await d.rejects(
    'chave ausente: nomeia a variável',
    async () => createClient(empty, true),
    /OPENAI_API_KEY/,
  );
  const image = await crop();
  const real = new RealOpenAi('sk-nao-usada');
  await d.rejects(
    'mask e markup juntos são recusados antes da rede',
    async () =>
      real.edit({
        model: 'm',
        prompt: 'p',
        size: '1024x640',
        quality: 'high',
        image,
        mask: image,
        markup: image,
      }),
    /juntos/,
  );
}

export async function runClientDrills(d: Drill): Promise<void> {
  await terminal(d);
  await refusals(d);
  await failures(d);
  await factory(d);
}
