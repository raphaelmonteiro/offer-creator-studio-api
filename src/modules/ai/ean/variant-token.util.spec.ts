import {
  contentTokens,
  discriminatorSignature,
  sharedRareTokens,
  unmatchedRareTokens,
  discriminatorsOf,
  normalizeText,
  overlapScore,
  variantGate,
} from './variant-token.util';

describe('variant-token.util', () => {
  describe('os falsos positivos reais que motivaram a camada 4', () => {
    // Todos vieram do dry-run em cima da base local. Em cada um, o EAN
    // seria gravado errado pela regra antiga (marca + quantidade + candidato único).

    it('rejeita Arisco: feijão da galeria vs tempero da OFF', () => {
      const r = variantGate('Feijão Canela Arisco Carioca', 'Tempero Arisco com Pimenta');
      expect(r.pass).toBe(false);
      expect(r.reason).toBe('conflito-de-variante');
      expect(r.conflictingGroup).toBe('tipoProduto');
    });

    it('rejeita Baton: "ao leite" vs "algodão doce"', () => {
      const r = variantGate('Baton ao leite', 'Baton sabor Algodão Doce 16G');
      expect(r.pass).toBe(false);
      expect(r.reason).toBe('conflito-de-variante');
      expect(r.conflictingGroup).toBe('sabor');
    });

    it('rejeita Campeiro: arroz branco vs parboilizado', () => {
      const r = variantGate('Arroz Campeiro Branco', 'Arroz Campeiro Parboilizado');
      expect(r.pass).toBe(false);
      expect(r.reason).toBe('conflito-de-variante');
      expect(r.conflictingGroup).toBe('variedade');
    });

    it('rejeita Divine: nenhum token em comum com "Due Passionate"', () => {
      const r = variantGate('Chocolate ao Leite 37% Cacau com Amendoim', 'Due Passionate');
      expect(r.pass).toBe(false);
    });

    it('rejeita Caldo Nobre: candidato não diz o tipo de feijão', () => {
      // A galeria sabe que é carioca (vem do filename); a OFF só diz "Feijão".
      // Sem evidência positiva de identidade, não dá para aceitar — foi assim
      // que carioca e preto acabaram no mesmo GTIN.
      const r = variantGate('Feijão Caldo Nobre carioca', 'Feijão Caldo Nobre - Classe Premium');
      expect(r.pass).toBe(false);
      expect(r.reason).toBe('candidato-subespecificado');
      expect(r.conflictingGroup).toBe('variedade');
    });
  });

  describe('aceita casamento genuíno', () => {
    it('passa quando variedade e tipo conferem', () => {
      const r = variantGate('Arroz Campeiro Parboilizado', 'Arroz Campeiro Parboilizado 5kg');
      expect(r.pass).toBe(true);
      expect(r.sharedTokens).toEqual(expect.arrayContaining(['arroz', 'parboilizado']));
    });

    it('passa quando nenhum lado declara discriminante mas há token comum', () => {
      const r = variantGate('Moranguete Bel', 'Moranguete');
      expect(r.pass).toBe(true);
      expect(r.sharedTokens).toContain('moranguete');
    });

    it('ausência nos DOIS lados não é conflito', () => {
      const r = variantGate('Achocolatado Instantâneo', 'Achocolatado Instantâneo Pote');
      expect(r.pass).toBe(true);
    });
  });

  describe('normalizeText', () => {
    it('remove acento e caixa', () => {
      expect(normalizeText('Feijão CARIOCA')).toBe('feijao carioca');
    });

    it('preserva percentual', () => {
      expect(normalizeText('37% Cacau')).toBe('37% cacau');
    });
  });

  describe('contentTokens', () => {
    it('descarta stopword, unidade e número puro', () => {
      const t = contentTokens('Arroz de 5 kg tipo 1 com Casca');
      expect(t.has('arroz')).toBe(true);
      expect(t.has('casca')).toBe(true);
      expect(t.has('kg')).toBe(false);
      expect(t.has('tipo')).toBe(false);
      expect(t.has('com')).toBe(false);
    });
  });

  describe('discriminatorsOf', () => {
    it('encontra termo de duas palavras', () => {
      expect(discriminatorsOf('Chocolate ao leite')['sabor']).toContain('ao leite');
    });

    it('agrupa por categoria', () => {
      const d = discriminatorsOf('Feijão carioca');
      expect(d['tipoProduto']).toContain('feijao');
      expect(d['variedade']).toContain('carioca');
    });
  });

  describe('overlapScore', () => {
    it('é 1 para textos equivalentes', () => {
      expect(overlapScore('Feijão carioca', 'feijao CARIOCA')).toBe(1);
    });

    it('é 0 sem interseção', () => {
      expect(overlapScore('Feijão carioca', 'Due Passionate')).toBe(0);
    });

    it('fica entre 0 e 1 com sobreposição parcial', () => {
      const s = overlapScore('Arroz Campeiro Branco', 'Arroz Campeiro Parboilizado');
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    });
  });

  describe('camada 4b — token raro compartilhado', () => {
    // Frequências reais medidas no dump BR (33.287 produtos).
    const N = 33287;
    const df = new Map<string, number>([
      ['chocolate', 1829], // 5,771% — comum
      ['leite', 1559], // 4,919% — comum
      ['arroz', 543], // 1,713% — comum
      ['branco', 357], // 1,126% — comum
      ['feijao', 210], // 0,663% — comum
      ['amargo', 118], // 0,372% — RARO
      ['meio', 95], // 0,300% — RARO
      ['bombom', 84], // 0,265% — RARO
      ['oreo', 37], // 0,117% — RARO
      ['negresco', 19], // 0,060% — RARO
      ['bono', 16], // 0,050% — RARO
      ['rocher', 5], // 0,016% — RARO
      ['chocotrio', 4], // 0,013% — RARO
      ['raffaello', 1], // 0,003% — RARO
    ]);

    it('rejeita Milka oreo vs Milka branco (só compartilha token comum)', () => {
      expect(
        sharedRareTokens('Milka oreo 100g', 'MILKA Chocolate Milka Branco', df, N, 'Milka'),
      ).toEqual([]);
    });

    it('rejeita Ferrero Raffaello vs Ferrero Rocher', () => {
      expect(
        sharedRareTokens(
          'Ferrero raffaello 150g',
          'Bombom Ferrero Rocher Bandeja',
          df,
          N,
          'Ferrero',
        ),
      ).toEqual([]);
    });

    it('rejeita Garoto chocotrio bono vs Garoto branco com Negresco', () => {
      expect(
        sharedRareTokens(
          'Garoto chocotrio bono 90g',
          'Chocolate Branco Com Biscoito Negresco',
          df,
          N,
          'Garoto',
        ),
      ).toEqual([]);
    });

    it('ACEITA casamento genuíno via token raro', () => {
      const shared = sharedRareTokens(
        'Garoto tablete meio amargo 80g',
        'Chocolate Meio Amargo Garoto Pacote',
        df,
        N,
        'Garoto',
      );
      expect(shared).toEqual(expect.arrayContaining(['meio', 'amargo']));
    });

    it('ignora o token da MARCA — ela já foi consumida pelo blocking', () => {
      // "milka" seria raro pela frequência, mas concordar nela é tautologia.
      const shared = sharedRareTokens(
        'Milka algo',
        'Milka outra coisa',
        new Map([['milka', 3]]),
        N,
        'Milka',
      );
      expect(shared).toEqual([]);
    });

    it('token comum sozinho nunca basta', () => {
      expect(sharedRareTokens('Chocolate ao leite', 'Chocolate branco', df, N, null)).toEqual([]);
    });
  });

  describe('camada 5b — assinatura de discriminantes', () => {
    it('fotos do mesmo produto têm a mesma assinatura', () => {
      expect(discriminatorSignature('Feijão carioca 1kg')).toBe(
        discriminatorSignature('feijao CARIOCA embalagem'),
      );
    });

    it('produtos diferentes têm assinaturas diferentes', () => {
      expect(discriminatorSignature('Camil tipo 1')).not.toBe(
        discriminatorSignature('Camil tipo 2'),
      );
      expect(discriminatorSignature('Feijão carioca')).not.toBe(
        discriminatorSignature('Feijão preto'),
      );
    });
  });

  describe('camada 4c — atributo discriminante sem correspondência', () => {
    const N = 33287;
    const df = new Map<string, number>([
      ['chocolate', 1829],
      ['bombom', 84],
      ['dark', 12], // raro
      ['prestigio', 9], // raro
      ['especialidades', 7],
    ]);

    it('rejeita "Kit Kat Dark" contra "Kit Kat" — dark sem correspondência', () => {
      expect(unmatchedRareTokens('Kit Kat Dark', 'Kit Kat', df, N, 'Kit Kat')).toContain('dark');
    });

    it('rejeita "Nestlé Prestígio Bombom" contra "Bombom Nestlé Especialidades"', () => {
      expect(
        unmatchedRareTokens('Prestigio Bombom', 'Bombom Nestlé Especialidades', df, N, 'Nestlé'),
      ).toContain('prestigio');
    });

    it('não reclama quando o discriminante aparece nos dois lados', () => {
      expect(unmatchedRareTokens('Kit Kat Dark', 'Kit Kat Dark 41g', df, N, 'Kit Kat')).toEqual([]);
    });

    it('token comum ausente não é atributo discriminante', () => {
      expect(unmatchedRareTokens('Chocolate especial', 'Barra especial', df, N, null)).toEqual([]);
    });

    it('ignora token da marca', () => {
      expect(unmatchedRareTokens('Prestigio', 'Bombom', df, N, 'Prestigio')).toEqual([]);
    });
  });
});
