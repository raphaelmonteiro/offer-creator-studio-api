import {
  buildDirectorJsonSchema,
  buildDirectorSystemPrompt,
  buildEndcard,
  buildMockScript,
  buildScriptSeal,
  durationBounds,
  MC_MAX_SCENES,
  MC_SCENE_MAX_S,
  MC_SCENE_MIN_S,
  normalizeDirectorScenes,
  sceneCountRange,
} from './mc-director';
import { sceneActionPromptEn } from './mc-types';

describe('mc-director — diretor multi-cena (plano §5.1 etapa 1 / contrato v1-B1)', () => {
  describe('sceneCountRange — nº de cenas por duração alvo', () => {
    it.each([
      [8, 1, 2],
      [15, 1, 2],
      [16, 2, 4],
      [30, 2, 4],
      [31, 4, 8],
      [60, 4, 8],
    ])('%is → %i..%i cenas', (durationS, min, max) => {
      expect(sceneCountRange(durationS)).toEqual({ min, max });
    });

    it('nunca passa do teto de 8 cenas do contrato', () => {
      expect(sceneCountRange(60).max).toBe(MC_MAX_SCENES);
    });
  });

  it('durationBounds é o alvo ±20%', () => {
    expect(durationBounds(30)).toEqual({ min: 24, max: 36 });
    expect(durationBounds(10)).toEqual({ min: 8, max: 12 });
  });

  describe('buildDirectorSystemPrompt — regras de produto no prompt', () => {
    const prompt = buildDirectorSystemPrompt({
      targetDurationS: 30,
      products: [{ name: 'Arroz Tio João', price: '19,90' }],
    });

    it('pede a faixa de cenas e a janela de duração da duração alvo', () => {
      expect(prompt).toContain('2 a 4 cenas');
      expect(prompt).toContain('30 segundos');
      expect(prompt).toContain('entre 24 e 36 segundos');
    });

    it('carrega as regras não-negociáveis do produto', () => {
      expect(prompt).toContain('UMA'); // uma ação física por cena
      expect(prompt).toContain('CONTINUIDADE');
      expect(prompt).toContain('mesmo corredor');
      expect(prompt).toMatch(/por extenso/);
      expect(prompt).toContain('nunca "9,99"');
      expect(prompt).toContain('actionPromptEn');
      expect(prompt).toContain('chamada para ação');
      expect(prompt).toContain('NADA de texto escrito');
    });

    it('REGRESSÃO (1ª produção real): exige fala que PREENCHA a cena, contada em PALAVRAS + exemplo', () => {
      // Falas de 18–32 chars em cenas de 6s fizeram um comercial de 30s sair
      // com 6,5s — o clipe do motor de fala acompanha a duração do áudio.
      // A contagem é em palavras (LLM erra caracteres) e vem com exemplo
      // bom/ruim, que é o que de fato move o comportamento do modelo.
      expect(prompt).toContain('REGRA CRÍTICA DE DURAÇÃO');
      expect(prompt).toContain('PREENCHE a cena');
      expect(prompt).toMatch(/de 6s ≈ 15 palavras/);
      expect(prompt).toMatch(/exemplo RUIM/i);
    });

    it('lista os produtos do projeto para as falas citarem', () => {
      expect(prompt).toContain('Arroz Tio João (R$ 19,90)');
    });

    it('sem produtos, não inventa a linha de ofertas', () => {
      const semProdutos = buildDirectorSystemPrompt({ targetDurationS: 12, products: [] });
      expect(semProdutos).not.toContain('Produtos em oferta');
      expect(semProdutos).toContain('1 a 2 cenas');
    });
  });

  describe('buildDirectorJsonSchema — structured output estrito do McScript v2', () => {
    const schema = buildDirectorJsonSchema() as {
      strict: boolean;
      schema: {
        properties: {
          scenes: {
            maxItems: number;
            items: { required: string[]; properties: Record<string, unknown> };
          };
        };
      };
    };

    it('é strict e limita a 8 cenas', () => {
      expect(schema.strict).toBe(true);
      expect(schema.schema.properties.scenes.maxItems).toBe(MC_MAX_SCENES);
    });

    it('exige os 4 campos da cena v2 (dialogue aceita null)', () => {
      const items = schema.schema.properties.scenes.items;
      expect(items.required.sort()).toEqual(
        ['actionPrompt', 'actionPromptEn', 'dialogue', 'durationS'].sort(),
      );
      expect(items.properties.dialogue).toEqual({ type: ['string', 'null'] });
    });
  });

  describe('normalizeDirectorScenes — saneamento da resposta do LLM', () => {
    it('reindexa, faz clamp da duração em 4..12s e normaliza fala vazia para null', () => {
      const scenes = normalizeDirectorScenes([
        { actionPrompt: 'Cena A', actionPromptEn: 'Scene A', dialogue: 'Oi!', durationS: 99 },
        { actionPrompt: 'Cena B', actionPromptEn: 'Scene B', dialogue: '   ', durationS: 1 },
      ]);
      expect(scenes).toEqual([
        {
          idx: 0,
          actionPrompt: 'Cena A',
          actionPromptEn: 'Scene A',
          dialogue: 'Oi!',
          durationS: MC_SCENE_MAX_S,
        },
        {
          idx: 1,
          actionPrompt: 'Cena B',
          actionPromptEn: 'Scene B',
          dialogue: null,
          durationS: MC_SCENE_MIN_S,
        },
      ]);
    });

    it('descarta cenas sem ação e corta no teto de 8', () => {
      const raw = Array.from({ length: 12 }, (_, i) => ({
        actionPrompt: `Cena ${i}`,
        actionPromptEn: `Scene ${i}`,
        dialogue: null,
        durationS: 5,
      }));
      raw.splice(2, 0, { actionPrompt: '  ', actionPromptEn: 'x', dialogue: null, durationS: 5 });
      const scenes = normalizeDirectorScenes(raw);
      expect(scenes).toHaveLength(MC_MAX_SCENES);
      expect(scenes.map((s) => s.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('fala longa demais é cortada no que cabe na cena', () => {
      const [scene] = normalizeDirectorScenes([
        { actionPrompt: 'A', actionPromptEn: 'A', dialogue: 'x'.repeat(500), durationS: 5 },
      ]);
      expect(scene.dialogue?.length).toBe(5 * 15 + 40);
    });

    it('sem cena utilizável → erro honesto em vez de roteiro vazio', () => {
      expect(() => normalizeDirectorScenes([{ actionPrompt: '' }])).toThrow(/sem cenas/);
      expect(() => normalizeDirectorScenes([])).toThrow(/sem cenas/);
    });

    it('cena sem actionPromptEn cai no pt (compat de roteiro v1)', () => {
      const [scene] = normalizeDirectorScenes([
        { actionPrompt: 'Mascote acena', dialogue: null, durationS: 6 },
      ]);
      expect(scene.actionPromptEn).toBeUndefined();
      expect(sceneActionPromptEn(scene)).toBe('Mascote acena');
    });
  });

  describe('selo e cartela', () => {
    it('buildScriptSeal limita a 6 produtos e descarta incompletos', () => {
      const products = Array.from({ length: 8 }, (_, i) => ({
        name: `P${i}`,
        price: `${i},99`,
      }));
      products.push({ name: '  ', price: '1,00' });
      const seal = buildScriptSeal(products);
      expect(seal?.products).toHaveLength(6);
      expect(seal?.products?.[0]).toEqual({ name: 'P0', price: '0,99' });
    });

    it('sem produtos válidos → sem selo', () => {
      expect(buildScriptSeal([])).toBeNull();
      expect(buildScriptSeal([{ name: 'x', price: '  ' }])).toBeNull();
    });

    it('buildEndcard usa o tradeName; ausente/vazio → sem cartela', () => {
      expect(buildEndcard(' Mercado Bom Preço ')).toEqual({ storeName: 'Mercado Bom Preço' });
      expect(buildEndcard(null)).toBeNull();
      expect(buildEndcard('   ')).toBeNull();
    });
  });

  describe('buildMockScript — e2e multi-cena de custo zero', () => {
    const script = buildMockScript({
      products: [{ name: 'Café Pilão', price: '12,90' }],
      storeName: 'Mercado do Zé',
    });

    it('gera 3 cenas: 2 faladas + 1 muda', () => {
      expect(script.version).toBe(2);
      expect(script.scenes).toHaveLength(3);
      expect(script.scenes.filter((s) => s.dialogue !== null)).toHaveLength(2);
      expect(script.scenes.filter((s) => s.dialogue === null)).toHaveLength(1);
    });

    it('toda cena tem idx sequencial, versão EN e duração dentro do contrato', () => {
      script.scenes.forEach((scene, i) => {
        expect(scene.idx).toBe(i);
        expect(scene.actionPromptEn).toBeTruthy();
        expect(scene.durationS).toBeGreaterThanOrEqual(MC_SCENE_MIN_S);
        expect(scene.durationS).toBeLessThanOrEqual(MC_SCENE_MAX_S);
      });
    });

    it('mantém continuidade de cenário e preço por extenso na fala', () => {
      expect(script.scenes.every((s) => /corredor/i.test(s.actionPrompt))).toBe(true);
      expect(script.scenes[1].dialogue).toContain('nove e noventa e nove');
    });

    it('carrega selo dos produtos e cartela do estabelecimento', () => {
      expect(script.seal?.products).toEqual([{ name: 'Café Pilão', price: '12,90' }]);
      expect(script.endcard).toEqual({ storeName: 'Mercado do Zé' });
    });

    it('sem produtos/estabelecimento omite selo e cartela', () => {
      const enxuto = buildMockScript({});
      expect(enxuto.seal).toBeUndefined();
      expect(enxuto.endcard).toBeUndefined();
      expect(enxuto.scenes).toHaveLength(3);
    });
  });
});
