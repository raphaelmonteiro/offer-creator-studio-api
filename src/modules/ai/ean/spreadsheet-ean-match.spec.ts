import { SpreadsheetEanMatchService } from './spreadsheet-ean-match.service';
import { comoBuffer, LINHAS_LIMPAS, LINHAS_REAIS } from './ean-test-fixtures';

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

describe('SpreadsheetEanMatchService.processar — gravação', () => {
  const galeria = [
    {
      id: 'img-club',
      filename: 'Club Social - queijo 141g.png',
      url: '/uploads/club.png',
      metadata: {
        title: 'Biscoito Club Social Queijo',
        quantity: null,
        alternatives: [{ brand: 'Club Social', variant: 'queijo' }],
        ean: null,
        warnings: [],
      },
    },
  ];

  it('casamento por descrição não grava, mesmo com dryRun=false', async () => {
    const dataSource = { query: jest.fn().mockResolvedValue(galeria) };
    const embedding = { saveImageMetadata: jest.fn() };
    const service = new SpreadsheetEanMatchService(dataSource as never, embedding as never);

    const buffer = comoBuffer([
      ['codigo', 'produto'],
      ['7622300991333', 'BISCOITO CLUB SOCIAL 141G QUEIJO'],
    ]);
    const r = await service.processar(buffer, { dryRun: false });

    expect(r.casadaPorDescricao).toBe(1);
    expect(embedding.saveImageMetadata).not.toHaveBeenCalled();
  });
});
