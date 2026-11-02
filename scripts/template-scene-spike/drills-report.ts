import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import { decideA, decideB, decideC } from './decision';
import { Drill } from './drill-util';
import { rig, subset } from './drills-edit';
import { writeFixtures } from './fixtures';
import { ensureLabels, readLabels } from './labels';
import type { Labels } from './labels';
import { loadConfig, loadPrices } from './config';
import { loadCases } from './plan';
import { assertNoKeys, buildReport, writeReport } from './report';
import { collect } from './collect';

const ids = (p: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${p}${String(i + 1).padStart(2, '0')}`);
const A_IDS = ids('A', 20);

function aLabels(mech: string, atendeu: number, invisivel: number): Labels {
  const out: Labels = {};
  A_IDS.forEach((id, i) => {
    out[`${id}:${mech}`] = {
      edicao: i < atendeu ? 'atendeu' : 'errado',
      costura: i < invisivel ? 'invisivel' : 'visivel',
    };
  });
  return out;
}

const PROMOS = [
  { id: 'P1', atmospheric: true },
  { id: 'P2', atmospheric: false },
  { id: 'P3', atmospheric: false },
  { id: 'P4', atmospheric: false },
  { id: 'P5', atmospheric: false },
];

function bLabels(promo: string[], fallback: string[]): Labels {
  const out: Labels = {};
  PROMOS.forEach((p, i) => {
    out[`${p.id}:promo`] = { global: promo[i] };
    out[`${p.id}:fallback`] = { global: fallback[i] };
  });
  return out;
}

function decisionRules(d: Drill): void {
  d.section('Regra de decisão por bloco');
  const rep = decideA({ ...aLabels('mask', 14, 20), ...aLabels('markup', 12, 20) }, A_IDS, [
    'mask',
    'markup',
  ]);
  d.check(
    'A: 14 e 12 de 20 atendeu = reprovado (A3), sem sugerir outro fornecedor',
    rep.verdict === 'reprovado' &&
      /reprovado \(A3\): o estágio 4 não abre; a hipótese volta ao dono/.test(rep.text) &&
      !/Gemini|fornecedor/i.test(rep.text),
  );
  const ok = decideA({ ...aLabels('mask', 17, 19), ...aLabels('markup', 15, 20) }, A_IDS, [
    'mask',
    'markup',
  ]);
  d.check(
    'A: mask 17/19 aprova com o mecanismo mask e marca a fronteira',
    ok.verdict === 'aprovado' && /mecanismo mask/.test(ok.text) && /Fronteira/.test(ok.text),
  );
  const tie = decideA({ ...aLabels('mask', 18, 20), ...aLabels('markup', 18, 20) }, A_IDS, [
    'mask',
    'markup',
  ]);
  d.check('A: empate fica com mask (design, Alternativa I)', /mecanismo mask/.test(tie.text));
  const only = decideA(aLabels('mask', 18, 20), A_IDS, ['mask']);
  d.check('A: markup não medido, mask vence por exclusão', /por exclusão/.test(only.text));
  const pend = decideA(aLabels('mask', 17, 19), A_IDS, ['mask', 'markup']);
  d.check(
    'A: markup sem rótulos = pendente com a lista',
    pend.verdict === 'pendente' && pend.pending.length === 20,
  );
  const b2 = decideB(
    bLabels(
      ['nao', 'aceitavel', 'aceitavel', 'aceitavel', 'nao'],
      ['aceitavel', 'aceitavel', 'aceitavel', 'nao', 'nao'],
    ),
    PROMOS,
  );
  d.check(
    'B: 3 de 4 destacáveis e o sol "nao" = segue com fallback (B2)',
    /segue com fallback \(B2\)/.test(b2.text),
  );
  const b1 = decideB(
    bLabels(
      ['aceitavel', 'aceitavel', 'aceitavel', 'aceitavel', 'nao'],
      ['aceitavel', 'aceitavel', 'aceitavel', 'nao', 'nao'],
    ),
    PROMOS,
  );
  d.check('B: 3 de 4 e o sol aceitável = B1', /\(B1\): estágio 6 segue/.test(b1.text));
  const b3 = decideB(
    bLabels(
      ['nao', 'aceitavel', 'aceitavel', 'nao', 'nao'],
      ['aceitavel', 'aceitavel', 'nao', 'nao', 'nao'],
    ),
    PROMOS,
  );
  d.check(
    'B: 2 de 4 e fallback 2 de 5 = B3 e mover sai do chat',
    /promoção abandonada \(B3\) e fallback reprovado: mover sai do chat/.test(b3.text) &&
      /remover/.test(b3.text) &&
      /adicionar/.test(b3.text),
  );
  const b3b = decideB(
    bLabels(
      ['nao', 'aceitavel', 'aceitavel', 'nao', 'nao'],
      ['aceitavel', 'aceitavel', 'aceitavel', 'nao', 'nao'],
    ),
    PROMOS,
  );
  d.check(
    'B: B3 com fallback bom = repintura de origem e destino com aviso',
    /mover = repintura de origem e destino com aviso/.test(b3b.text),
  );
  const bp = decideB({}, PROMOS);
  d.check(
    'B: sem rótulos = pendente com os casos a rotular',
    bp.verdict === 'pendente' && bp.pending.length === 5,
  );
  const c = decideC(
    {
      'O1:shape': { edicao: 'atendeu', nuvem: 'intacta', costura: 'invisivel' },
      'O2:shape': { edicao: 'atendeu', nuvem: 'intacta', costura: 'invisivel' },
    },
    ['O1', 'O2', 'O3'],
  );
  d.check('C: 2 de 3 confirma o pincel ou laço (PV-14)', c.verdict === 'aprovado');
  const partial = `${decideA(aLabels('mask', 20, 20), A_IDS, ['mask']).verdict}/${decideB({}, PROMOS).verdict}`;
  d.check(
    'rótulos incompletos: o bloco rotulado mostra a decisão e o outro fica pendente',
    partial === 'aprovado/pendente',
  );
}

async function packages(d: Drill): Promise<void> {
  d.section('Relatório, rótulos e pacote de fixtures');
  const base = loadCases();
  const cases = subset(base, {
    edits: base.edits.filter((e) => ['A01', 'A04', 'O1'].includes(e.id)),
    marginSubset: [],
    promotions: [base.promotions[1]],
  });
  const r = await rig('report', cases);
  await r.run({});
  r.svc.session.lock.release();
  const dir = r.svc.session.dir;
  const config = loadConfig({} as NodeJS.ProcessEnv);
  const prices = loadPrices();
  const ledgerBefore = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
  const file = writeReport(dir, cases, config, prices, true);
  d.check(
    'report.md gerado, sem chamada paga (ledger intacto)',
    fs.existsSync(file) && fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8') === ledgerBefore,
  );
  const text = fs.readFileSync(file, 'utf8');
  d.check(
    'relatório traz preços com fonte, gasto e a tabela provisório → recomendado',
    /developers\.openai\.com/.test(text) &&
      /Gasto total/.test(text) &&
      /provisório/.test(text) &&
      /feather/.test(text),
  );
  const labels = readLabels(dir);
  d.check(
    'labels.json vazio com uma entrada por saída',
    ['A01:mask', 'A01:markup', 'O1:rect', 'O1:shape', 'P2:promo', 'P2:fallback'].every(
      (k) => labels[k] && Object.values(labels[k]).every((v) => v === null),
    ),
  );
  fs.writeFileSync(
    path.join(dir, 'labels.json'),
    JSON.stringify({ ...labels, 'A01:mask': { edicao: 'atendeu', costura: 'invisivel' } }),
  );
  ensureLabels(dir, ['A01:mask', 'Z99:mask']);
  d.check(
    'regerar não apaga rótulos preenchidos',
    readLabels(dir)['A01:mask'].edicao === 'atendeu' && !!readLabels(dir)['Z99:mask'],
  );
  d.check(
    'bloco sem rótulos aparece como pendente',
    /PENDENTE/.test(
      buildReport(collect(dir, cases), readLabels(dir), base, {
        dir,
        config,
        prices,
        dryRun: true,
      }),
    ),
  );
  const manifestFile = await writeFixtures(dir, cases);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    scenes: Array<{ scenePreview: string }>;
    cases: Array<{
      block: string;
      worst: boolean;
      region: { x: number; y: number; w: number; h: number };
      mask?: { kind: string };
      before: string;
    }>;
  };
  const inUnit = (v: number): boolean => v >= 0 && v <= 1;
  d.check(
    'region com x, y, w, h entre 0 e 1',
    manifest.cases.every((c) => Object.values(c.region).every(inUnit)),
  );
  d.check(
    'mask é brush ou lasso quando existe',
    manifest.cases.every((c) => !c.mask || ['brush', 'lasso'].includes(c.mask.kind)),
  );
  const blocks = ['A', 'B', 'C'];
  d.check(
    'um único worst por bloco',
    blocks.every((b) => manifest.cases.filter((c) => c.block === b && c.worst).length === 1),
  );
  const sizes = await Promise.all(
    manifest.cases
      .filter((c) => c.before)
      .map(
        async (c) =>
          (await sharp(path.join(dir, 'fixtures', c.before)).metadata()) as {
            width: number;
            height: number;
            format: string;
          },
      ),
  );
  d.check(
    'prévias WebP de até 1024 px no maior lado',
    sizes.length > 0 &&
      sizes.every((s) => s.format === 'webp' && Math.max(s.width, s.height) <= 1024),
  );
  fs.writeFileSync(path.join(dir, 'planted.txt'), 'token=sk-segredo-de-teste-123456');
  let caught = false;
  try {
    assertNoKeys(dir, ['sk-segredo-de-teste-123456']);
  } catch {
    caught = true;
  }
  fs.unlinkSync(path.join(dir, 'planted.txt'));
  assertNoKeys(dir, ['sk-segredo-de-teste-123456']);
  d.check('busca pela chave em out/ acha a plantada e não acha nada na saída real', caught);
}

export async function runReportDrills(d: Drill): Promise<void> {
  decisionRules(d);
  await packages(d);
}
