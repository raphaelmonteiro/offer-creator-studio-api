import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as XLSX from 'xlsx';
import { classifyEan } from './dotcompany-lookup.service';
import { parseImportFile } from './ean-import-file.parser';

/** Cadastro real do laboratório (fora do git do backend); o teste roda só se ele existir. */
const ARCOS = join(__dirname, '../../../../../../ean-lab/data/catalogs/arcos.csv');

describe('parseImportFile', () => {
  it('CSV com ";" e cabeçalho NO_PRODUTO/EAN', () => {
    const csv = Buffer.from(
      '   ;NO_PRODUTO;EAN\n1;LEITE MOÇA 395G;7891000100103\n2;OREO 90G;7622300873554\n',
    );
    const r = parseImportFile(csv);
    expect(r.columns).toEqual({ ean: 'EAN', description: 'NO_PRODUTO' });
    expect(r.rows).toEqual([
      { rowNumber: 2, ean: '7891000100103', description: 'LEITE MOÇA 395G' },
      { rowNumber: 3, ean: '7622300873554', description: 'OREO 90G' },
    ]);
  });

  it('CSV em Windows-1252 (export de ERP) mantém os acentos', () => {
    const latin = Buffer.from('Descrição,Código de barras\nPÃO FRANCÊS,7891000100103\n', 'latin1');
    const r = parseImportFile(latin);
    expect(r.rows[0]).toMatchObject({ description: 'PÃO FRANCÊS', ean: '7891000100103' });
    expect(r.columns.ean).toBe('Código de barras');
  });

  it('aspas com delimitador dentro do campo', () => {
    const r = parseImportFile(
      Buffer.from('nome;ean\n"BISCOITO; RECHEADO ""OREO""";7622300873554\n'),
    );
    expect(r.rows[0].description).toBe('BISCOITO; RECHEADO "OREO"');
  });

  it('EAN repetido: só a primeira ocorrência é processada', () => {
    const r = parseImportFile(Buffer.from('nome;ean\nA;7891000100103\nB;07891000100103\n'));
    expect(r.rows[0].result).toBeUndefined();
    expect(r.rows[1]).toMatchObject({ result: 'duplicate', reason: 'EAN repetido no arquivo' });
  });

  it('linha com EAN inválido continua no relatório (decidida depois)', () => {
    const r = parseImportFile(Buffer.from('nome;ean\nA;7891000100104\nB;\n'));
    expect(r.rows.map((x) => x.ean)).toEqual(['7891000100104', '']);
  });

  it('XLSX com EAN numérico', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Produto', 'GTIN'],
      ['MOÇA', 7891000100103],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'p');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    expect(parseImportFile(buf).rows[0]).toMatchObject({
      ean: '7891000100103',
      description: 'MOÇA',
    });
  });

  it('notação científica que perdeu dígitos não vira EAN', () => {
    const r = parseImportFile(Buffer.from('nome;ean\nA;7,89652E+12\nB;7.891000100103E+12\n'));
    expect(classifyEan(r.rows[0].ean).status).toBe('invalid');
    expect(r.rows[1].ean).toBe('7891000100103');
  });

  it('sem cabeçalho reconhecível: acha a coluna pelo conteúdo', () => {
    const r = parseImportFile(Buffer.from('7891000100103;LEITE MOÇA\n7622300873554;OREO\n'));
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      rowNumber: 1,
      ean: '7891000100103',
      description: 'LEITE MOÇA',
    });
  });

  it('sem coluna de EAN: erro que nomeia as colunas encontradas', () => {
    expect(() => parseImportFile(Buffer.from('nome;preco\nA;1,99\nB;2,50\n'))).toThrow(
      /Colunas do arquivo: nome, preco/,
    );
  });

  (existsSync(ARCOS) ? it : it.skip)('cadastro da Arcos: 3.128 linhas, 3.118 consultáveis', () => {
    const r = parseImportFile(readFileSync(ARCOS));
    expect(r.rows).toHaveLength(3128);
    const consultaveis = r.rows.filter((x) => !x.result && classifyEan(x.ean).status === 'valid');
    expect(consultaveis).toHaveLength(3118);
  });
});
