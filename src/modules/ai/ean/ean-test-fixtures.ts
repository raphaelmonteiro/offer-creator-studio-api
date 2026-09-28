import * as XLSX from 'xlsx';

/**
 * Fixture com as linhas REAIS do arquivo que o cliente enviou
 * ("OFERTA 17 a 20 SETEMBRO FLV"), incluindo o cabeçalho original — que não
 * contém a palavra "descrição" em lugar nenhum. A coluna de produto se chama
 * "FLV 17 A 20 SETEMBRO", e é por isso que a detecção é por conteúdo.
 */
export const LINHAS_REAIS = [
  ['PLU', 'EAN', 'FLV 17 A 20 SETEMBRO', 'Novo Preço'],
  ['1', '8372', 'BATATA LAVADA KG TOCANTINS', 'R$ 3,97'],
  ['5', '01073-3', 'ABOBORA MORANGA interno', 'R$ 3,47'],
  ['17', '84761-2', '0789894991208-8', 'TOMATE GRAPE RIVELO BDJ'],
  ['18', '847568', '0789894991201-9', 'MORANGO RIVELO interno BDJ'],
];

/** Mesmo arquivo, já normalizado em 4 colunas (como virá do ERP). */
export const LINHAS_LIMPAS = [
  ['PLU', 'EAN', 'FLV 17 A 20 SETEMBRO', 'Novo Preço'],
  ['1', '8372', 'BATATA LAVADA KG TOCANTINS', 'R$ 3,97'],
  ['5', '01073-3', 'ABOBORA MORANGA interno', 'R$ 3,47'],
  ['17', '0789894991208-8', 'TOMATE GRAPE RIVELO BDJ', 'R$ 3,97'],
  ['18', '0789894991201-9', 'MORANGO RIVELO interno BDJ', 'R$ 10,97'],
  ['19', '0789666122001-6', 'OVOS JOVANIL 20UN EXTRA BRANCO BDJ', 'R$ 9,97'],
  ['21', '0789614820048-7', 'ACELGA JAN TEM UN', 'R$ 2,97'],
  ['25', '0789614820017-3', 'COUVE MANTEIGA JAN TEM', 'R$ 2,97'],
  ['30', '0789821741061-2', 'MAÇA PCT 850G PCT', 'R$ 5,97'],
  ['38', '0619151430019-0', 'TAMARA PCT 200 GR', 'R$ 4,97'],
];

export function comoBuffer(linhas: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Plan1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
