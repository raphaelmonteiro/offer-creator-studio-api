import * as fs from 'fs';
import * as path from 'path';

/** Rótulos humanos (D-4): uma entrada por saída; `null` = ainda sem rótulo. */
export type LabelEntry = Record<string, string | null>;
export type Labels = Record<string, LabelEntry>;

export const LABEL_LEGEND = {
  edicao: 'atendeu | parcial | nao_fez_nada | errado',
  costura: 'invisivel | visivel',
  nuvem: '(bloco C) intacta | alterada',
  recorte: '(bloco B) limpo | borda_dura | vazio',
  buraco: '(bloco B) sem_fantasma | fantasma',
  'borda_16/32/64': '(bloco B) integrada | colagem, por largura da faixa do retoque',
  global:
    '(bloco B, promoção e fallback) aceitavel | sim | nao. Só `aceitavel` conta como aceito nos critérios',
};

const EMPTY_EDIT: LabelEntry = { edicao: null, costura: null };
const EMPTY_OVERLAP: LabelEntry = { edicao: null, costura: null, nuvem: null };
const EMPTY_PROMO: LabelEntry = {
  recorte: null,
  buraco: null,
  borda_16: null,
  borda_32: null,
  borda_64: null,
  global: null,
};
const EMPTY_FALLBACK: LabelEntry = { global: null };

/** Entrada vazia do tipo certo para a chave de um resultado. */
export function emptyLabelFor(key: string): LabelEntry {
  if (key.endsWith(':promo')) return { ...EMPTY_PROMO };
  if (key.endsWith(':fallback')) return { ...EMPTY_FALLBACK };
  if (key.endsWith(':rect') || key.endsWith(':shape')) return { ...EMPTY_OVERLAP };
  return { ...EMPTY_EDIT };
}

export function labelsPath(dir: string): string {
  return path.join(dir, 'labels.json');
}

export function readLabels(dir: string): Labels {
  const file = labelsPath(dir);
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Labels & { _legenda?: unknown };
  const { _legenda, ...labels } = raw;
  void _legenda;
  return labels;
}

/** Gera `labels.json` vazio ou acrescenta as chaves que faltam, sem tocar nos rótulos já preenchidos. */
export function ensureLabels(dir: string, keys: string[]): Labels {
  const labels = readLabels(dir);
  for (const key of keys) if (!labels[key]) labels[key] = emptyLabelFor(key);
  fs.writeFileSync(
    labelsPath(dir),
    JSON.stringify({ _legenda: LABEL_LEGEND, ...labels }, null, 2),
    'utf8',
  );
  return labels;
}
