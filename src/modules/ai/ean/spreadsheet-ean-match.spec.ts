import * as XLSX from 'xlsx';
import { SpreadsheetEanMatchService } from './spreadsheet-ean-match.service';

/**
 * Fixture com as linhas REAIS do arquivo que o cliente enviou
 * ("OFERTA 17 a 20 SETEMBRO FLV"), incluindo o cabeçalho original — que não
 * contém a palavra "descrição" em lugar nenhum. A coluna de produto se chama
 * "FLV 17 A 20 SETEMBRO", e é por isso que a detecção é por conteúdo.
 */
const LINHAS_REAIS = [
  ['PLU', 'EAN', 'FLV 17 A 20 SETEMBRO', 'Novo Preço'],
  ['1', '8372', 'BATATA LAVADA KG TOCANTINS', 'R$ 3,97'],
  ['5', '01073-3', 'ABOBORA MORANGA interno', 'R$ 3,47'],
  ['17', '84761-2', '0789894991208-8', 'TOMATE GRAPE RIVELO BDJ'],
  ['18', '847568', '0789894991201-9', 'MORANGO RIVELO interno BDJ'],
];

/** Mesmo arquivo, já normalizado em 4 colunas (como virá do ERP). */
const LINHAS_LIMPAS = [
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

function comoBuffer(linhas: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Plan1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('SpreadsheetEanMatchService', () => {
  const service = new SpreadsheetEanMatchService({} as never, {} as never);

  describe('detectarColunas — por conteúdo, não por cabeçalho', () => {
    it('acha a coluna de EAN mesmo com cabeçalho genérico', () => {
      const cols = service.detectarColunas(LINHAS_LIMPAS);
      expect(cols).not.toBeNull();
      expect(cols!.ean).toBe(1);
    });

    it('acha a coluna de descrição pelo volume de texto', () => {
      // O cabeçalho é "FLV 17 A 20 SETEMBRO" — nenhuma heurística de nome
      // acertaria. A coluna 3 (preço) tem pouca letra; a 2 tem muita.
      expect(service.detectarColunas(LINHAS_LIMPAS)!.descricao).toBe(2);
    });

    it('funciona mesmo com as colunas deslocadas em algumas linhas', () => {
      const cols = service.detectarColunas(LINHAS_REAIS);
      expect(cols).not.toBeNull();
    });

    it('devolve null quando não há nenhum EAN válido', () => {
      expect(
        service.detectarColunas([
          ['codigo', 'produto'],
          ['8372', 'BATATA'],
          ['10009', 'ALHO'],
        ]),
      ).toBeNull();
    });
  });

  describe('lerPlanilha', () => {
    it('separa as linhas com EAN válido das demais', () => {
      const r = service.lerPlanilha(comoBuffer(LINHAS_LIMPAS));
      expect(r.linhas).toHaveLength(7);
      // cabeçalho + batata (PLU 8372) + abóbora (PLU interno 01073-3)
      expect(r.semEan).toBe(3);
    });

    it('normaliza o formato do cliente (zero à esquerda e hífen)', () => {
      const r = service.lerPlanilha(comoBuffer(LINHAS_LIMPAS));
      const tomate = r.linhas.find((l) => l.descricao.includes('TOMATE GRAPE'));
      expect(tomate).toBeDefined();
      expect(tomate!.eanBruto).toBe('0789894991208-8');
      expect(tomate!.ean).toBe('07898949912088');
    });

    it('descarta PLU interno da loja', () => {
      const r = service.lerPlanilha(comoBuffer(LINHAS_LIMPAS));
      expect(r.linhas.some((l) => l.descricao.includes('BATATA'))).toBe(false);
      expect(r.linhas.some((l) => l.descricao.includes('ABOBORA'))).toBe(false);
    });

    it('preserva o número da linha original para conferência', () => {
      const r = service.lerPlanilha(comoBuffer(LINHAS_LIMPAS));
      expect(r.linhas[0].linha).toBe(4); // 1-based, depois do cabeçalho e 2 sem EAN
    });

    it('aceita CSV também', () => {
      const csv = LINHAS_LIMPAS.map((l) => l.join(',')).join('\n');
      const r = service.lerPlanilha(Buffer.from(csv, 'utf8'));
      expect(r.linhas.length).toBe(7);
    });
  });
});
