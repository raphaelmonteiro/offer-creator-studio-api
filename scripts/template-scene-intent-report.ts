/**
 * Relatório da avaliação paga da intenção (task 1.45). Lê `pass1.jsonl` (e `pass2.jsonl`, que substitui
 * as frases repetidas depois do ajuste de prompt) e escreve `report.md` e `per-phrase.md` na mesma pasta.
 * Não chama a rede.
 *
 *   node -r ts-node/register -r tsconfig-paths/register scripts/template-scene-intent-report.ts --out <pasta>
 */
import * as fs from 'fs';
import * as path from 'path';
import { fold } from '../src/modules/template-scenes/domain/scene-request-text';

interface Intent {
  action: string;
  zone: string | null;
  object: string | null;
  subject: string | null;
  imagePrompt: string | null;
  relativePlace: boolean;
}
interface Row {
  id: string;
  group: string;
  message: string;
  marked: boolean;
  expect: Intent;
  accept: Array<{ action: string; zone: string | null }>;
  status: string;
  got: Intent | null;
  costUsd: number | null;
  latencyMs: number;
  expectedOp: string;
  gotOp: string | null;
  actionZoneOk: boolean;
  outcomeOk: boolean;
  costly: boolean;
}

const out = process.argv[process.argv.indexOf('--out') + 1];
const read = (name: string): Row[] => {
  const file = path.join(out, name);
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};
const pass1 = read('pass1.jsonl');
const pass2 = read('pass2.jsonl');
const final = new Map<string, Row>();
for (const row of [...pass1, ...pass2]) final.set(row.id, row);
const rows = [...final.values()];
const state = JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8'));

const pct = (n: number, d: number): string =>
  d === 0 ? 'n/d' : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
const count = (list: Row[], test: (r: Row) => boolean): number => list.filter(test).length;
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const words = (text: string | null): string[] =>
  fold(text ?? '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
const sharesWord = (a: string | null, b: string | null): boolean => {
  const wa = words(a);
  return words(b).some((w) => wa.some((x) => x.startsWith(w) || w.startsWith(x)));
};

const owner = rows.filter((r) => r.group === 'dono');
const wrong = rows.filter((r) => !r.actionZoneOk);
const actionOk = count(
  rows,
  (r) =>
    r.got !== null && [r.expect.action, ...r.accept.map((a) => a.action)].includes(r.got.action),
);
const zoneOk = count(
  rows,
  (r) => r.got !== null && [r.expect.zone, ...r.accept.map((a) => a.zone)].includes(r.got.zone),
);
const invalid = count(rows, (r) => r.status === 'invalid');
const timeouts = count(rows, (r) => r.status === 'timeout');
const errors = count(rows, (r) => r.status === 'error');
const latencies = rows.map((r) => r.latencyMs);
const costs = rows.map((r) => r.costUsd).filter((c): c is number => c !== null);
const costly = rows.filter((r) => r.costly);
const sameOutcome = count(rows, (r) => r.outcomeOk);

// object e subject: comparação automática com o esperado (a leitura por uma pessoa fica na amostra)
const withObject = rows.filter(
  (r) => r.status === 'ok' && ['remove', 'integrate'].includes(r.expect.action),
);
const objectOk = count(withObject, (r) =>
  r.expect.object === null
    ? r.got?.object === null
    : sharesWord(r.expect.object, r.got?.object ?? null),
);
const withSubject = rows.filter((r) => r.status === 'ok' && r.expect.subject !== null);
const subjectOk = count(withSubject, (r) => sharesWord(r.expect.subject, r.got?.subject ?? null));
const byGroup = (g: string) => rows.filter((r) => r.group === g);

const lines: string[] = [];
lines.push('# Task 1.45: avaliação paga da intenção (add-template-scene-local-edit)');
lines.push('');
lines.push(
  `Frases avaliadas: ${rows.length} (passada 1: ${pass1.length}; passada 2, só as que erraram: ${pass2.length}). Só texto, modelo \`gpt-6-luna\`, sem chamada de imagem.`,
);
lines.push(
  `**Custo total: US$ ${state.spentUsd.toFixed(6)}** em ${state.calls} chamadas (teto US$ 0,06; ${state.unknownCostCalls ?? 0} chamada(s) sem \`usage\` contada(s) a US$ 0,0004 cada, por conservadorismo).`,
);
lines.push('');
lines.push('## Critério de acerto');
lines.push('');
lines.push('| Medida | Mínimo | Resultado | Passou |');
lines.push('| --- | --- | --- | --- |');
const ownerOk = count(owner, (r) => r.actionZoneOk);
const setOk = count(rows, (r) => r.actionZoneOk);
const row = (m: string, min: string, res: string, ok: boolean) =>
  lines.push(`| ${m} | ${min} | ${res} | ${ok ? 'sim' : '**não**'} |`);
row(
  'Frases do dono (versões 2 a 8 e 10, com e sem marcação), `action` e `zone`',
  '100%',
  pct(ownerOk, owner.length),
  ownerOk === owner.length,
);
row('Erro caro', '0', String(costly.length), costly.length === 0);
row(
  'Conjunto inteiro, `action` e `zone`',
  '95%',
  pct(setOk, rows.length),
  setOk / rows.length >= 0.95,
);
row('Conjunto inteiro, só `action`', '(informativo)', pct(actionOk, rows.length), true);
row('Conjunto inteiro, só `zone`', '(informativo)', pct(zoneOk, rows.length), true);
row('Mesmo efeito (operação do plano)', '(informativo)', pct(sameOutcome, rows.length), true);
row(
  '`object` (comparação automática; leitura por pessoa pendente)',
  '90%',
  pct(objectOk, withObject.length),
  objectOk / Math.max(1, withObject.length) >= 0.9,
);
row(
  '`subject` (comparação automática; leitura por pessoa pendente)',
  '90%',
  pct(subjectOk, withSubject.length),
  subjectOk / Math.max(1, withSubject.length) >= 0.9,
);
row('Saída inválida', 'até 1%', pct(invalid, rows.length), invalid / rows.length <= 0.01);
row(
  'Tempo esgotado (8 s) ou erro',
  '(informativo)',
  `${timeouts} tempo esgotado, ${errors} erro`,
  true,
);
row(
  'Latência p95',
  'até 3 s',
  `${(percentile(latencies, 95) / 1000).toFixed(2)} s (p50 ${(percentile(latencies, 50) / 1000).toFixed(2)} s; máx. ${(Math.max(...latencies) / 1000).toFixed(2)} s)`,
  percentile(latencies, 95) <= 3000,
);
const mean = costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length);
row(
  'Custo médio por mensagem',
  'abaixo de US$ 0,001',
  `US$ ${mean.toFixed(6)} (${costs.length} chamadas com \`usage\`)`,
  mean < 0.001,
);
lines.push('');
lines.push('## Por grupo (`action` e `zone`)');
lines.push('');
lines.push('| Grupo | Acertos |');
lines.push('| --- | --- |');
for (const g of ['dono', 'tabela', 'rodada3', 'spec'])
  lines.push(
    `| ${g} | ${pct(
      count(byGroup(g), (r) => r.actionZoneOk),
      byGroup(g).length,
    )} |`,
  );
lines.push('');
lines.push(`## Erros (${wrong.length}): frase, esperado, obtido`);
lines.push('');
for (const r of wrong) {
  const exp = [r.expect, ...r.accept].map((e) => `${e.action}/${e.zone ?? '-'}`).join(' ou ');
  const got = r.got ? `${r.got.action}/${r.got.zone ?? '-'}` : `(${r.status})`;
  lines.push(
    `- \`${r.id}\` [${r.group}, ${r.marked ? 'com' : 'sem'} marcação]${r.costly ? ' **ERRO CARO**' : ''}: "${r.message}" | esperado ${exp} | obtido ${got}${r.gotOp ? ` (${r.expectedOp} -> ${r.gotOp})` : ''}`,
  );
}
fs.writeFileSync(path.join(out, 'report.md'), `${lines.join('\n')}\n`);

const per: string[] = [
  '# Saída por frase',
  '',
  '| id | grupo | marc. | frase | esperado | obtido | ok | custo | ms |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
for (const r of rows) {
  const g = r.got
    ? `${r.got.action}/${r.got.zone ?? '-'} obj=${r.got.object ?? '-'} sub=${r.got.subject ?? '-'} rel=${r.got.relativePlace} img="${r.got.imagePrompt ?? '-'}"`
    : `(${r.status})`;
  const e = `${r.expect.action}/${r.expect.zone ?? '-'} obj=${r.expect.object ?? '-'} sub=${r.expect.subject ?? '-'} rel=${r.expect.relativePlace}${r.accept.length ? ` [aceita ${r.accept.map((a) => a.action).join(',')}]` : ''}`;
  per.push(
    `| ${r.id} | ${r.group} | ${r.marked ? 'sim' : 'não'} | ${r.message.replace(/\|/g, '/')} | ${e} | ${g} | ${r.actionZoneOk ? 'ok' : '**ERRO**'} | ${r.costUsd ?? '-'} | ${r.latencyMs} |`,
  );
}
fs.writeFileSync(path.join(out, 'per-phrase.md'), `${per.join('\n')}\n`);
process.stdout.write(`${lines.slice(0, 26).join('\n')}\n`);
