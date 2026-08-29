import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MascotScriptRequestDto } from '../dto/mascot-script-request.dto';
import { integerToWordsPtBr, priceToWordsPtBr, spellOutPricesPtBr } from './price-to-words.util';
import {
  PT_BR_CHARS_PER_SECOND,
  buildFallbackScript,
  charBudgetForSeconds,
  estimateSpeechSeconds,
  extractFlyerProducts,
  rankOffers,
  suggestProductCount,
} from './mascot-script.util';

describe('Roteiro do mascote (spike §4)', () => {
  describe('preços por extenso — o TTS lê número mal', () => {
    it('faz o caso do spike: 19,90 vira "dezenove e noventa"', () => {
      expect(priceToWordsPtBr(19.9)).toBe('dezenove e noventa');
    });

    it('preço redondo vira "N reais"', () => {
      expect(priceToWordsPtBr(5)).toBe('cinco reais');
      expect(priceToWordsPtBr(1)).toBe('um real');
      expect(priceToWordsPtBr(59)).toBe('cinquenta e nove reais');
      expect(priceToWordsPtBr(100)).toBe('cem reais');
    });

    it('centavos sozinhos e casos de borda', () => {
      expect(priceToWordsPtBr(0.99)).toBe('noventa e nove centavos');
      expect(priceToWordsPtBr(0.01)).toBe('um centavo');
      expect(priceToWordsPtBr(0)).toBe('de graça');
      expect(priceToWordsPtBr(-3)).toBe('');
    });

    it('arredonda em centavos antes de separar (19,999 não vira "e cem")', () => {
      expect(priceToWordsPtBr(19.999)).toBe('vinte reais');
      expect(priceToWordsPtBr(9.996)).toBe('dez reais');
    });

    it('inteiros por extenso cobrem a faixa de preço de encarte', () => {
      expect(integerToWordsPtBr(0)).toBe('zero');
      expect(integerToWordsPtBr(15)).toBe('quinze');
      expect(integerToWordsPtBr(21)).toBe('vinte e um');
      expect(integerToWordsPtBr(101)).toBe('cento e um');
      expect(integerToWordsPtBr(999)).toBe('novecentos e noventa e nove');
      expect(integerToWordsPtBr(1000)).toBe('mil');
      expect(integerToWordsPtBr(1200)).toBe('mil e duzentos');
      expect(integerToWordsPtBr(1250)).toBe('mil duzentos e cinquenta');
      expect(integerToWordsPtBr(2000)).toBe('dois mil');
    });

    it('rede de segurança: troca preços que escaparam no texto', () => {
      expect(spellOutPricesPtBr('Arroz por R$ 19,90 hoje')).toBe(
        'Arroz por dezenove e noventa hoje',
      );
      expect(spellOutPricesPtBr('Leva por 5,00')).toBe('Leva por cinco reais');
      expect(spellOutPricesPtBr('R$5 no pacote')).toBe('cinco reais no pacote');
      expect(spellOutPricesPtBr('Sem preço aqui')).toBe('Sem preço aqui');
    });
  });

  describe('estimativa de duração antes de gastar TTS', () => {
    it('usa ~15 caracteres por segundo em pt-BR', () => {
      expect(PT_BR_CHARS_PER_SECOND).toBe(15);
      expect(estimateSpeechSeconds('x'.repeat(150))).toBe(10);
      expect(estimateSpeechSeconds('x'.repeat(75))).toBe(5);
    });

    it('normaliza espaços e trata texto vazio', () => {
      expect(estimateSpeechSeconds('   ')).toBe(0);
      expect(estimateSpeechSeconds('')).toBe(0);
      expect(estimateSpeechSeconds('a   b')).toBe(estimateSpeechSeconds('a b'));
    });

    it('o orçamento de caracteres usa o ritmo mais LENTO (pior caso)', () => {
      expect(charBudgetForSeconds(12)).toBe(168); // 12 × 14
      expect(charBudgetForSeconds(0)).toBe(0);
    });

    it('sugere quantas ofertas cabem na duração', () => {
      expect(suggestProductCount(12)).toBe(3);
      expect(suggestProductCount(30)).toBe(8);
      expect(suggestProductCount(5)).toBe(1);
    });
  });

  describe('extração das ofertas reais do encarte', () => {
    const documentoV2 = {
      pages: [
        {
          pageNumber: 1,
          elements: [
            { id: 's1', type: 'section', title: 'Hortifruti' },
            {
              id: 'e1',
              type: 'product',
              productData: {
                id: 'p1',
                name: 'Arroz 5kg',
                price: 19.9,
                originalPrice: 24.9,
                unit: 'un',
                category: 'Mercearia',
              },
            },
            {
              id: 'e2',
              type: 'product',
              productData: { id: 'p2', name: 'Picanha', price: 59.9, unit: 'kg' },
            },
          ],
        },
      ],
    };

    it('lê produtos do documento do Editor V2', () => {
      const products = extractFlyerProducts(documentoV2);
      expect(products).toHaveLength(2);
      expect(products[0]).toMatchObject({
        id: 'p1',
        name: 'Arroz 5kg',
        price: 19.9,
        originalPrice: 24.9,
        priceSpelled: 'dezenove e noventa',
      });
      expect(products[1].priceSpelled).toBe('cinquenta e nove e noventa');
    });

    it('lê a configuration legada (array de produtos solto)', () => {
      const legado = { products: [{ id: 'x', name: 'Feijão 1kg', price: 8.49, unit: 'un' }] };
      const products = extractFlyerProducts(legado);
      expect(products).toHaveLength(1);
      expect(products[0].priceSpelled).toBe('oito e quarenta e nove');
    });

    it('ignora entradas sem nome ou sem preço válido', () => {
      const doc = {
        elements: [
          { productData: { name: '', price: 10 } },
          { productData: { name: 'Sem preço' } },
          { productData: { name: 'Preço zero', price: 0 } },
          { productData: { name: 'Ok', price: 3 } },
        ],
      };
      expect(extractFlyerProducts(doc).map((p) => p.name)).toEqual(['Ok']);
    });

    it('deduplica o mesmo produto repetido em páginas diferentes', () => {
      const doc = { pages: [documentoV2.pages[0], documentoV2.pages[0]] };
      expect(extractFlyerProducts(doc)).toHaveLength(2);
    });

    it('documento vazio ou inválido não quebra', () => {
      expect(extractFlyerProducts(null)).toEqual([]);
      expect(extractFlyerProducts({})).toEqual([]);
      expect(extractFlyerProducts('nada')).toEqual([]);
    });

    it('ordena por maior desconto e depois pelo menor preço', () => {
      const ranked = rankOffers([
        { id: 'a', name: 'A', price: 10, priceSpelled: '' },
        { id: 'b', name: 'B', price: 20, originalPrice: 40, priceSpelled: '' },
        { id: 'c', name: 'C', price: 5, priceSpelled: '' },
      ]);
      expect(ranked.map((p) => p.id)).toEqual(['b', 'c', 'a']);
    });
  });

  describe('roteiro determinístico (sem IA, sem custo)', () => {
    const produtos = [
      {
        id: 'p1',
        name: 'Arroz 5kg',
        price: 19.9,
        unit: 'un',
        priceSpelled: 'dezenove e noventa',
      },
      {
        id: 'p2',
        name: 'Picanha',
        price: 59.9,
        unit: 'kg',
        priceSpelled: 'cinquenta e nove e noventa',
      },
    ];

    it('escreve locução de varejo com os preços por extenso', () => {
      const script = buildFallbackScript({ products: produtos, tone: 'animado', storeName: 'Zé' });
      expect(script).toContain('Arroz 5kg por dezenove e noventa');
      expect(script).toContain('Picanha por cinquenta e nove e noventa o kg');
      expect(script).toContain('Zé');
    });

    it('nunca escreve algarismo de preço', () => {
      const script = buildFallbackScript({ products: produtos, tone: 'institucional' });
      expect(script).not.toMatch(/R\$/);
      expect(script).not.toMatch(/\d+,\d{2}/);
    });

    it('tom institucional não usa exclamação de varejo', () => {
      const script = buildFallbackScript({ products: produtos, tone: 'institucional' });
      expect(script).not.toContain('Corre');
    });

    it('sem produtos ainda devolve algo locucionável', () => {
      const script = buildFallbackScript({ products: [], tone: 'animado' });
      expect(script.length).toBeGreaterThan(20);
    });

    it('respeita a chamada final escolhida pelo usuário', () => {
      const script = buildFallbackScript({
        products: produtos,
        tone: 'animado',
        callToAction: 'Só hoje na loja da esquina.',
      });
      expect(script.endsWith('Só hoje na loja da esquina.')).toBe(true);
    });
  });

  describe('MascotScriptRequestDto', () => {
    const errorsOf = async (payload: object) => {
      const dto = plainToInstance(MascotScriptRequestDto, payload);
      const errors = await validate(dto, { whitelist: true });
      return errors.flatMap((e) =>
        Object.keys(e.constraints ?? {}).map((k) => `${e.property}.${k}`),
      );
    };

    const valido = {
      flyerId: 'a2f4b6c8-1234-4abc-9def-112233445566',
      tone: 'animado',
      maxSeconds: 12,
    };

    it('payload válido passa', async () => {
      expect(await errorsOf(valido)).toEqual([]);
    });

    it('flyerId precisa ser UUID', async () => {
      const errors = await errorsOf({ ...valido, flyerId: 'nao-e-uuid' });
      expect(errors.some((e) => e.startsWith('flyerId.'))).toBe(true);
    });

    it('tone fora do catálogo é rejeitado', async () => {
      const errors = await errorsOf({ ...valido, tone: 'engraçado' });
      expect(errors.some((e) => e.startsWith('tone.'))).toBe(true);
    });

    it('maxSeconds fora de 5–60 é rejeitado', async () => {
      expect(
        (await errorsOf({ ...valido, maxSeconds: 2 })).some((e) => e.includes('maxSeconds')),
      ).toBe(true);
      expect(
        (await errorsOf({ ...valido, maxSeconds: 120 })).some((e) => e.includes('maxSeconds')),
      ).toBe(true);
    });

    it('maxProducts é opcional mas limitado a 8', async () => {
      expect(await errorsOf({ ...valido, maxProducts: 4 })).toEqual([]);
      expect(
        (await errorsOf({ ...valido, maxProducts: 20 })).some((e) => e.includes('maxProducts')),
      ).toBe(true);
    });

    it('callToAction não pode passar de 120 caracteres', async () => {
      const errors = await errorsOf({ ...valido, callToAction: 'x'.repeat(121) });
      expect(errors.some((e) => e.includes('callToAction'))).toBe(true);
    });
  });
});
