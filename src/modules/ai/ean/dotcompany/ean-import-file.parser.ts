import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { classifyEan } from './dotcompany-lookup.service';
import type { NewImportRow } from './ean-import.store';

/** Cabeçalhos reconhecidos (já normalizados: minúsculas, sem acento, só [a-z0-9_]). */
const EAN_HEADERS = new Set([
  'ean',
  'ean13',
  'ean_13',
  'gtin',
  'gtin13',
  'codigo_barras',
  'codigo_de_barras',
  'cod_barras',
  'cod_de_barras',
  'codbarras',
  'cod_barra',
  'codigo_barra',
  'barcode',
]);
const DESCRIPTION_HEADERS = new Set([
  'descricao',
  'descricao_produto',
  'desc',
  'no_produto',
  'nome',
  'nome_produto',
  'produto',
  'ds_produto',
  'descricao_item',
  'item',
]);

export interface ParsedImportFile {
  rows: NewImportRow[];
  columns: { ean: string; description: string | null };
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** UTF-8 quando o arquivo é UTF-8 válido; senão Windows-1252 (export de ERP). */
function decodeText(buffer: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  return text.replace(/^﻿/, '');
}

function detectDelimiter(firstLine: string): string {
  const counts = [';', ',', '\t', '|'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ';';
}

/** CSV com aspas (RFC 4180) — campos com o delimitador ou quebra de linha entre aspas. */
function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** EAN numérico de planilha: número inteiro vira dígitos; notação científica só se não perdeu dígitos. */
function eanCellToText(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value.toFixed(0) : String(value);
  }
  const text = String(value ?? '').trim();
  const sci = text.replace(',', '.').match(/^(\d+(?:\.\d+)?)e\+?(\d+)$/i);
  if (sci) {
    const n = Number(`${sci[1]}e${sci[2]}`);
    const mantissaDigits = sci[1].replace('.', '').length;
    // "7,89652E+12" perdeu dígitos: não dá para recuperar com segurança.
    if (Number.isInteger(n) && mantissaDigits >= n.toFixed(0).length) return n.toFixed(0);
    return text;
  }
  return text;
}

function isXlsx(buffer: Buffer): boolean {
  // XLSX é um ZIP (PK\x03\x04); XLS antigo é OLE (D0 CF 11 E0).
  return (
    (buffer[0] === 0x50 && buffer[1] === 0x4b) ||
    (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0)
  );
}

function readGrid(buffer: Buffer): unknown[][] {
  if (isXlsx(buffer)) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: true,
      defval: '',
    });
  }
  return parseCsv(decodeText(buffer)).filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Coluna cujo conteúdo mais parece EAN (para arquivo sem cabeçalho reconhecível). */
function guessEanColumn(rows: unknown[][]): number {
  const sample = rows.slice(0, 200);
  const nCols = Math.max(0, ...sample.map((r) => r.length));
  let best = -1;
  let bestCount = 0;
  for (let c = 0; c < nCols; c++) {
    const valid = sample.filter(
      (r) => classifyEan(eanCellToText(r[c])).status !== 'invalid',
    ).length;
    if (valid > bestCount) {
      bestCount = valid;
      best = c;
    }
  }
  return bestCount >= Math.max(1, Math.floor(sample.length * 0.3)) ? best : -1;
}

function guessDescriptionColumn(rows: unknown[][], eanCol: number): number {
  const sample = rows.slice(0, 200);
  const nCols = Math.max(0, ...sample.map((r) => r.length));
  let best = -1;
  let bestLetters = 0;
  for (let c = 0; c < nCols; c++) {
    if (c === eanCol) continue;
    const letters = sample.reduce(
      (acc, r) => acc + String(r[c] ?? '').replace(/[^A-Za-zÀ-ÿ]/g, '').length,
      0,
    );
    if (letters > bestLetters) {
      bestLetters = letters;
      best = c;
    }
  }
  return best;
}

/**
 * Lê o cadastro de um cliente (CSV `;`/`,`/tab, UTF-8 ou Windows-1252, ou
 * XLSX) e devolve TODAS as linhas com EAN e descrição — a validade do EAN é
 * decidida depois, para o relatório dizer o motivo de cada linha. EAN repetido
 * no arquivo: só a primeira ocorrência é processada.
 */
export function parseImportFile(buffer: Buffer): ParsedImportFile {
  if (!buffer?.length) throw new BadRequestException('Arquivo vazio.');
  const grid = readGrid(buffer);
  if (grid.length === 0) throw new BadRequestException('Arquivo sem linhas.');

  const header = grid[0].map(normalizeHeader);
  let eanCol = header.findIndex((h) => EAN_HEADERS.has(h));
  let descCol = header.findIndex((h) => DESCRIPTION_HEADERS.has(h));
  let body = grid.slice(1);
  let firstRowNumber = 2;

  if (eanCol < 0) {
    // Sem cabeçalho conhecido: tenta pelo conteúdo, contando a 1ª linha como dado.
    const guess = guessEanColumn(grid);
    if (guess < 0) {
      const found = grid[0].map((v) => String(v ?? '').trim()).filter(Boolean);
      throw new BadRequestException(
        `Não encontrei a coluna de EAN. Colunas do arquivo: ${found.length ? found.join(', ') : '(nenhuma)'}. ` +
          'Use um cabeçalho como EAN, GTIN ou Código de barras.',
      );
    }
    eanCol = guess;
    const headerLooksLikeData = classifyEan(eanCellToText(grid[0][eanCol])).status !== 'invalid';
    if (headerLooksLikeData) {
      body = grid;
      firstRowNumber = 1;
    }
    descCol = descCol >= 0 ? descCol : guessDescriptionColumn(body, eanCol);
  }

  const rows: NewImportRow[] = [];
  const seen = new Set<string>();
  body.forEach((r, i) => {
    const ean = eanCellToText(r[eanCol]).trim();
    const description = descCol >= 0 ? String(r[descCol] ?? '').trim() : '';
    if (!ean && !description) return;
    const rowNumber = firstRowNumber + i;
    const c = classifyEan(ean);
    const key = c.status === 'invalid' ? null : c.ean;
    if (key && seen.has(key)) {
      rows.push({
        rowNumber,
        ean: c.ean,
        description,
        result: 'duplicate',
        reason: 'EAN repetido no arquivo',
      });
      return;
    }
    if (key) seen.add(key);
    rows.push({ rowNumber, ean: ean.replace(/\s/g, ''), description });
  });

  if (rows.length === 0) throw new BadRequestException('Nenhuma linha com EAN ou descrição.');
  return {
    rows,
    columns: {
      ean: String(grid[0][eanCol] ?? `coluna ${eanCol + 1}`).trim() || `coluna ${eanCol + 1}`,
      description:
        descCol >= 0 ? String(grid[0][descCol] ?? '').trim() || `coluna ${descCol + 1}` : null,
    },
  };
}
