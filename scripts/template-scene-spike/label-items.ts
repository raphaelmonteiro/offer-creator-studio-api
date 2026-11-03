import * as path from 'path';
import { collect } from './collect';
import type { EditResult } from './edit-cases';
import { fieldsOf } from './label-store';
import type { CasesFile } from './types';

export interface LabelImage {
  label: string;
  /** Caminho relativo à pasta de saída do spike. */
  path: string;
}

export interface LabelItem {
  key: string;
  block: 'A' | 'C' | 'B';
  title: string;
  request: string;
  images: LabelImage[];
  fields: string[];
}

const rel = (dir: string, file: string): string => path.relative(dir, file);

function editItem(dir: string, e: EditResult, title: string): LabelItem {
  const images: LabelImage[] = [
    { label: 'antes', path: rel(dir, e.files.before) },
    { label: 'saída bruta', path: rel(dir, e.files.raw) },
    { label: 'final (feather 24)', path: rel(dir, e.files.final) },
  ];
  if (e.files.final48)
    images.push({ label: 'final (feather 48)', path: rel(dir, e.files.final48) });
  if (e.files.mask) images.push({ label: 'máscara', path: rel(dir, e.files.mask) });
  return {
    key: e.key,
    block: e.block as 'A' | 'C',
    title,
    request: e.request,
    images,
    fields: fieldsOf(e.key),
  };
}

/** As 41 saídas na ordem do `report.md`: A, margem de 8%, C e B (promoção e fallback). */
export function buildItems(dir: string, cases: CasesFile): LabelItem[] {
  const c = collect(dir, cases);
  const items: LabelItem[] = [];
  for (const e of c.edits.filter((x) => x.block === 'A' && x.variant !== 'm8'))
    items.push(editItem(dir, e, `${e.key} (bloco A)`));
  for (const e of c.edits.filter((x) => x.variant === 'm8'))
    items.push(editItem(dir, e, `${e.key} (margem de 8%)`));
  for (const e of c.edits.filter((x) => x.block === 'C'))
    items.push(
      editItem(dir, e, `${e.key} (bloco C, ${e.variant === 'rect' ? 'retângulo' : 'pincel/laço'})`),
    );
  for (const p of c.promos) {
    const img = (label: string, file?: string): LabelImage[] =>
      file ? [{ label, path: rel(dir, file) }] : [];
    const bands = p.retouch.flatMap((r) => img(`borda ${r.band} px`, r.files.final));
    items.push({
      key: p.key,
      block: 'B',
      title: `${p.key} (promoção de ${p.target})`,
      request: `${p.target}: promover a elemento e mover`,
      images: [
        ...img('antes', p.files.before),
        ...img('recorte', p.files.cutout),
        ...img('buraco preenchido', p.fill?.files.final),
        ...img('colagem', p.files.pasted),
        ...bands,
      ],
      fields: fieldsOf(p.key),
    });
  }
  for (const f of c.fallbacks) {
    items.push({
      key: f.key,
      block: 'B',
      title: `${f.key} (fallback de ${f.target})`,
      request: `${f.target}: repintura de origem e destino`,
      images: [
        { label: 'antes', path: rel(dir, f.files.before) },
        { label: 'origem (sem o item)', path: rel(dir, f.source.files.final) },
        { label: 'destino (desenhado)', path: rel(dir, f.files.final) },
      ],
      fields: fieldsOf(f.key),
    });
  }
  return items;
}

/** Resolve um caminho pedido pela página; recusa o que sai da pasta de saída ou não é imagem. */
export function safeImagePath(dir: string, requested: string): string | null {
  const root = path.resolve(dir) + path.sep;
  const full = path.resolve(dir, requested);
  if (!full.startsWith(root) || !/\.(png|webp|jpe?g)$/i.test(full)) return null;
  return full;
}
