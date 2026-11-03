import * as fs from 'fs';
import * as path from 'path';
import { Drill } from './drill-util';
import { rig, subset } from './drills-edit';
import { createLabelServer, listen } from './label-server';
import { isComplete, LabelError, readEntries, setLabel } from './label-store';
import { ensureLabels, labelsPath } from './labels';
import { loadCases } from './plan';
import { buildItems, safeImagePath } from './label-items';

async function rejectsWith(fn: () => unknown, status: number): Promise<boolean> {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof LabelError && e.status === status;
  }
}

export async function runLabelDrills(d: Drill): Promise<void> {
  d.section('Rotulador: gravador atômico e servidor local (sem chamada paga)');
  const base = loadCases();
  const cases = subset(base, {
    edits: base.edits.filter((e) => ['A01', 'O1'].includes(e.id)),
    marginSubset: [],
    promotions: [base.promotions[1]],
  });
  const r = await rig('label', cases);
  await r.run({ markup: false });
  r.svc.session.lock.release();
  const dir = r.svc.session.dir;
  const items = buildItems(dir, cases);
  const keys = items.map((i) => i.key);
  ensureLabels(dir, keys);
  const legendBefore = JSON.stringify(
    (JSON.parse(fs.readFileSync(labelsPath(dir), 'utf8')) as { _legenda: unknown })._legenda,
  );
  d.check(
    'itens na ordem A, C, B com imagens e campos',
    items.map((i) => i.block).join('') === 'ACCBB' &&
      items.every((i) => i.images.length >= 3 && i.fields.length >= 1),
  );

  const entry = setLabel(dir, keys, 'A01:mask', 'edicao', 'atendeu');
  const file = JSON.parse(fs.readFileSync(labelsPath(dir), 'utf8')) as Record<
    string,
    Record<string, string | null>
  > & { _legenda: unknown };
  d.check(
    'grava o valor e preserva a _legenda e as outras chaves',
    entry.edicao === 'atendeu' &&
      file['A01:mask'].edicao === 'atendeu' &&
      JSON.stringify(file._legenda) === legendBefore &&
      keys.every((k) => file[k]),
  );
  d.check(
    'escrita atômica: nenhum arquivo temporário sobra',
    fs.readdirSync(dir).every((n) => !n.endsWith('.tmp')),
  );
  d.check(
    'troca de valor funciona e null limpa',
    setLabel(dir, keys, 'A01:mask', 'edicao', 'parcial').edicao === 'parcial' &&
      setLabel(dir, keys, 'A01:mask', 'edicao', null).edicao === null,
  );
  d.check(
    'recusa valor fora da legenda (400)',
    await rejectsWith(() => setLabel(dir, keys, 'A01:mask', 'edicao', 'otimo'), 400),
  );
  d.check(
    'recusa campo de outro tipo de saída (400)',
    await rejectsWith(() => setLabel(dir, keys, 'A01:mask', 'borda_16', 'integrada'), 400),
  );
  d.check(
    'recusa chave desconhecida (404)',
    await rejectsWith(() => setLabel(dir, keys, 'Z99:mask', 'edicao', 'atendeu'), 404),
  );
  d.check(
    'completo só com todos os campos preenchidos',
    !isComplete(readEntries(dir, keys)['A01:mask']),
  );
  d.check(
    'caminho fora da pasta de saída é recusado',
    safeImagePath(dir, '../../etc/passwd.png') === null &&
      safeImagePath(dir, 'labels.json') === null &&
      safeImagePath(dir, items[0].images[0].path) !== null,
  );

  const server = createLabelServer(dir, cases);
  const port = await listen(server, 0);
  try {
    const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
    const list = (await (await fetch(url('/api/items'))).json()) as {
      items: unknown[];
      labels: Record<string, unknown>;
    };
    d.check(
      'GET /api/items traz itens e rótulos carregados',
      list.items.length === 5 && Object.keys(list.labels).length === 5,
    );
    const html = await (await fetch(url('/'))).text();
    d.check(
      'GET / serve a página com o contador e o filtro',
      /completos/.test(html) && /só pendentes/.test(html),
    );
    const post = await fetch(url('/api/label'), {
      method: 'POST',
      body: JSON.stringify({ key: 'O1:rect', field: 'nuvem', value: 'intacta' }),
    });
    d.check(
      'POST /api/label grava no labels.json',
      post.status === 200 && readEntries(dir, keys)['O1:rect'].nuvem === 'intacta',
    );
    const bad = await fetch(url('/api/label'), {
      method: 'POST',
      body: JSON.stringify({ key: 'O1:rect', field: 'nuvem', value: 'x' }),
    });
    d.check('POST com valor inválido volta 400', bad.status === 400);
    const ok = await fetch(url(`/img?p=${encodeURIComponent(items[0].images[0].path)}`));
    const out = await fetch(url(`/img?p=${encodeURIComponent('../../../package.json')}`));
    const outPng = await fetch(
      url(`/img?p=${encodeURIComponent(path.join('..', '..', '..', 'x.png'))}`),
    );
    d.check(
      'imagem dentro de out/ vai, fora de out/ é 403',
      ok.status === 200 &&
        ok.headers.get('content-type') === 'image/png' &&
        out.status === 403 &&
        outPng.status === 403,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
