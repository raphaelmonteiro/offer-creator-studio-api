import type { Services } from './calls';
import { StopError } from './budget';
import { loadConfig, loadPrices } from './config';
import { Drill, drillDir } from './drill-util';
import { runEdit } from './edit-runner';
import type { EditOptions } from './edit-runner';
import { FakeOpenAi, providerError } from './fake-openai';
import type { FakeOptions } from './fake-openai';
import { runGenerate } from './generate';
import { loadCases } from './plan';
import { FakeRemover } from './remover';
import type { Remover } from './remover';
import { SceneStore } from './scene-store';
import { openSession } from './session';
import type { CasesFile } from './types';
import type { EditResult } from './edit-cases';
import type { PromoResult } from './promote';

interface Rig {
  svc: Services;
  cases: CasesFile;
  run: (opts?: EditOptions, remover?: Remover | null) => Promise<void>;
}

const subset = (cases: CasesFile, keep: Partial<CasesFile>): CasesFile => ({ ...cases, ...keep });

async function rig(
  name: string,
  cases: CasesFile,
  fake: FakeOptions = {},
  budgetUsd = 100,
): Promise<Rig> {
  const session = openSession(drillDir(name), true, {
    budgetUsd,
    initialReserveUsd: 2,
    maxCallUsd: 3,
  });
  const svc: Services = {
    config: loadConfig({} as NodeJS.ProcessEnv),
    prices: loadPrices(),
    client: new FakeOpenAi(fake),
    session,
  };
  await runGenerate(svc, cases);
  const scenes = new SceneStore(session.dir, cases);
  return {
    svc,
    cases,
    run: (opts = {}, remover = new FakeRemover(0.5)) =>
      runEdit({ svc, cases, remover, scenes, opts }),
  };
}

const stopCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'none';
  } catch (e) {
    return e instanceof StopError ? e.code : 'erro';
  }
};

async function blocksAandC(d: Drill, base: CasesFile): Promise<void> {
  d.section('Edição local (blocos A e C): resultados por caso e retomada');
  const cases = subset(base, {
    edits: base.edits.filter((e) => ['A01', 'A04', 'A08', 'O1'].includes(e.id)),
    marginSubset: ['A01'],
    promotions: [],
  });
  const r = await rig('edit-ac', cases);
  await r.run({ block: 'A' });
  await r.run({ block: 'C' });
  const { state, ledger } = r.svc.session;
  const keys = [
    'A01:mask',
    'A01:markup',
    'A04:mask',
    'A08:markup',
    'A01:m8',
    'O1:rect',
    'O1:shape',
  ];
  d.check(
    'todos os casos done',
    keys.every((k) => state.statusOf(k) === 'done'),
  );
  const a01 = state.readResult<EditResult>('A01:mask')!;
  d.check(
    'resultado tem métricas, custo do usage, latência por etapa e request id',
    a01.metrics.insideMaskDiffRatio > 0 &&
      a01.costUsd > 0 &&
      !!a01.latencyMs.provider &&
      !!a01.requestId,
  );
  d.check('pedido pequeno registra grown', a01.grown && !a01.downscaled);
  d.check('zona larga registra downscaled', state.readResult<EditResult>('A08:markup')!.downscaled);
  const m8 = state.readResult<EditResult>('A01:m8')!;
  d.check(
    'margem de 8% maior que a de 4% (só mask)',
    m8.mechanism === 'mask' && m8.marginPx > a01.marginPx,
  );
  const rect = state.readResult<EditResult>('O1:rect')!;
  const shape = state.readResult<EditResult>('O1:shape')!;
  d.check(
    'bloco C mede a vizinha nas duas variantes',
    !!rect.neighbor &&
      !!shape.neighbor &&
      rect.neighbor.areaPx === shape.neighbor.areaPx &&
      rect.neighbor.areaPx > 0,
  );
  d.check(
    'feather: varredura de 5 valores e τ gravadas por caso',
    a01.featherSweep.length === 5 && a01.tauSweep.length === 5,
  );
  const paid = ledger.entries().filter((e) => e.step === 'edit');
  d.check(
    'ledger só com linhas dry_run',
    ledger.entries().every((e) => e.status === 'dry_run') && paid.length === 9,
  );
  const before = ledger.entries().length;
  await r.run({});
  d.check(
    'nova execução não refaz casos done',
    ledger.entries().length === before ||
      ledger
        .entries()
        .slice(before)
        .every((e) => e.block === 'E'),
  );
  await r.run({ block: 'E' });
  const vision = state.readResult<{ parseOk: boolean }>('E:A01:mask');
  d.check('bloco E grava a resposta simulada por caso', vision?.parseOk === true);
  const total = ledger.entries().length;
  await r.run({});
  d.check('plano concluído: nenhuma chamada paga nova', ledger.entries().length === total);
  r.svc.session.lock.release();
}

async function refusals(d: Drill, base: CasesFile): Promise<void> {
  d.section('Braço markup recusado e mask recusada');
  const five = subset(base, {
    edits: base.edits.filter((e) => ['A01', 'A02', 'A03', 'A05'].includes(e.id)),
    marginSubset: [],
    promotions: [],
  });
  const err = providerError(400, 'invalid_request', "Unknown parameter: 'markup'");
  const r = await rig('edit-markup', five, {
    inject: (_n, _op, arm) => (arm === 'markup' ? err : null),
  });
  await r.run({ block: 'A' });
  const st = r.svc.session.state;
  d.check(
    'mask segue e conclui os 4 pedidos',
    ['A01', 'A02', 'A03', 'A05'].every((id) => st.statusOf(`${id}:mask`) === 'done'),
  );
  d.check(
    'duas recusas desligam o braço: os demais markup ficam skipped com motivo',
    st.statusOf('A01:markup') === 'failed' &&
      st.statusOf('A02:markup') === 'failed' &&
      st.statusOf('A03:markup') === 'skipped' &&
      /P3/.test(st.reasonOf('A05:markup') ?? ''),
  );
  r.svc.session.lock.release();
  const mask = providerError(400, 'invalid_request', 'Invalid mask');
  const m = await rig('edit-mask', five, { inject: (_n, op) => (op === 'edit' ? mask : null) });
  d.check(
    'duas recusas de mask param o spike',
    (await stopCode(() => m.run({ block: 'A' }))) === 'mask_refused',
  );
  d.check('o estado fica gravado', m.svc.session.state.statusOf('A01:mask') === 'failed');
  m.svc.session.lock.release();
}

async function stops(d: Drill, base: CasesFile): Promise<void> {
  d.section('Teto, quota e recomposição');
  const two = subset(base, {
    edits: base.edits.filter((e) => ['A01', 'A02'].includes(e.id)),
    marginSubset: [],
    promotions: [],
  });
  const cap = await rig('edit-teto', two, {}, 6.5);
  cap.svc.session.ledger.append({
    ts: '',
    runId: 'x',
    caseId: 'x',
    block: 'A',
    step: 'edit',
    kind: 'edit',
    provider: 'openai',
    endpoint: 'e',
    model: 'm',
    costUsd: 5,
    costEstimated: false,
    latencyMs: 1,
    status: 'dry_run',
  });
  d.check(
    'teto atingido: para antes da chamada',
    (await stopCode(() => cap.run({ block: 'A' }))) === 'budget',
  );
  d.check(
    'nenhuma edição foi feita',
    cap.svc.session.ledger.entries().filter((e) => e.step === 'edit' && e.caseId !== 'x').length ===
      0,
  );
  cap.svc.session.lock.release();
  const quota = await rig('edit-quota', two, {
    inject: (_n, op) => (op === 'edit' ? providerError(429, 'insufficient_quota', 'quota') : null),
  });
  d.check(
    'quota: para na hora, sem retentativa',
    (await stopCode(() => quota.run({ block: 'A' }))) === 'quota' &&
      quota.svc.session.ledger.entries().filter((e) => e.step === 'edit').length === 1,
  );
  quota.svc.session.lock.release();
}

async function promotions(d: Drill, base: CasesFile): Promise<void> {
  d.section('Promoção a elemento e fallback (bloco B)');
  const promos = subset(base, { edits: [], marginSubset: [], promotions: base.promotions });
  const ok = await rig('edit-b', subset(promos, { promotions: [base.promotions[1]] }));
  await ok.run({ block: 'B' });
  const p2 = ok.svc.session.state.readResult<PromoResult>('P2:promo')!;
  d.check(
    'promoção completa: fundo removido, preenchimento, colagem e 3 retoques',
    p2.cutout === 'ok' &&
      !!p2.fill &&
      !!p2.paste &&
      p2.retouch.map((x) => x.band).join() === '16,32,64',
  );
  d.check(
    'interior do elemento preservado em todos os retoques',
    p2.retouch.every((x) => x.interiorPreserved),
  );
  d.check('fallback roda no mesmo caso', ok.svc.session.state.statusOf('P2:fallback') === 'done');
  d.check(
    'backend/uploads/ não recebe arquivos (recorte em cutouts/ do spike)',
    p2.files.cutout.includes('scripts/out/'),
  );
  ok.svc.session.lock.release();

  const empty = await rig('edit-p6', promos);
  await empty.run({ block: 'B' }, new FakeRemover(0));
  const st = empty.svc.session.state;
  const covered = ['P2', 'P3', 'P4'].every(
    (id) => st.readResult<PromoResult>(`${id}:promo`)?.cutout === 'vazio',
  );
  d.check(
    '3 destacáveis com recorte vazio: etapas pagas da promoção de P5 não rodam',
    covered && st.statusOf('P5:promo') === 'skipped' && /P6/.test(st.reasonOf('P5:promo') ?? ''),
  );
  d.check('o fallback roda em todos os casos', cases5(st, 'fallback'));
  d.check(
    'recorte vazio não gasta preenchimento nem retoque',
    empty.svc.session.ledger
      .entries()
      .every((e) => e.step !== 'fill' && !e.step.startsWith('retouch')),
  );
  empty.svc.session.lock.release();

  const noToken = await rig('edit-b-token', subset(promos, { promotions: [base.promotions[0]] }));
  await noToken.run({ block: 'B' }, null);
  d.check(
    'sem token do Replicate: bloco B skipped com o motivo, fallback também não foi pulado',
    noToken.svc.session.state.statusOf('P1:promo') === 'skipped' &&
      /REPLICATE_API_TOKEN/.test(noToken.svc.session.state.reasonOf('P1:promo') ?? ''),
  );
  noToken.svc.session.lock.release();

  const edge = { ...base.promotions[1], destination: { x: 0.95, y: 0.4, w: 0.17, h: 0.4 } };
  const oob = await rig('edit-b-oob', subset(promos, { promotions: [edge] }));
  await oob.run({ block: 'B' });
  d.check(
    'destino fora da cena: failed com paste_out_of_bounds',
    oob.svc.session.state.statusOf('P2:promo') === 'failed' &&
      /paste_out_of_bounds/.test(oob.svc.session.state.reasonOf('P2:promo') ?? ''),
  );
  oob.svc.session.lock.release();
}

function cases5(st: { statusOf(k: string): string }, kind: string): boolean {
  return ['P1', 'P2', 'P3', 'P4', 'P5'].every((id) => st.statusOf(`${id}:${kind}`) === 'done');
}

export async function runEditDrills(d: Drill): Promise<void> {
  const base = loadCases();
  await blocksAandC(d, base);
  await refusals(d, base);
  await stops(d, base);
  await promotions(d, base);
}
