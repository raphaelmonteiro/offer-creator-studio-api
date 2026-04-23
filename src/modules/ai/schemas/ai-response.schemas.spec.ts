import {
  parseImageIntentClassification,
  parseSpellCheckResponse,
  parseTemplateElementResponse,
  parseTemplateGenerateResponse,
  parseTemplateLayersComposition,
} from './ai-response.schemas';

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe('ai-response.schemas', () => {
  describe('parseSpellCheckResponse', () => {
    it('parses valid correction payloads', () => {
      const result = parseSpellCheckResponse(
        json({
          corrections: [
            {
              productId: 'p1',
              field: 'name',
              original: 'Macarao',
              suggestion: 'Macarrão',
            },
          ],
        }),
      );

      expect(result).toEqual([
        {
          productId: 'p1',
          field: 'name',
          original: 'Macarao',
          suggestion: 'Macarrão',
        },
      ]);
    });

    it('rejects invalid correction fields', () => {
      expect(() =>
        parseSpellCheckResponse(
          json({
            corrections: [
              {
                productId: 'p1',
                field: 'price',
                original: '10',
                suggestion: '11',
              },
            ],
          }),
        ),
      ).toThrow('Campo de correção inválido retornado pela IA');
    });
  });

  describe('parseTemplateElementResponse', () => {
    it('parses valid template element actions', () => {
      const result = parseTemplateElementResponse(
        json({
          assistantMessage: 'Pronto',
          actions: [
            {
              type: 'add-text',
              section: 'header',
              element: { type: 'text', content: 'Oferta' },
              elementId: null,
              updates: null,
              background: null,
            },
          ],
        }),
      );

      expect(result.assistantMessage).toBe('Pronto');
      expect(result.actions[0]).toMatchObject({
        type: 'add-text',
        section: 'header',
        element: { type: 'text', content: 'Oferta' },
      });
    });

    it('rejects actions with invalid section or type', () => {
      expect(() =>
        parseTemplateElementResponse(
          json({
            assistantMessage: 'Erro',
            actions: [{ type: 'add-text', section: 'sidebar' }],
          }),
        ),
      ).toThrow('Ação inválida retornada pelo GPT-4o');
    });
  });

  describe('parseTemplateGenerateResponse', () => {
    it('parses valid template configuration payloads', () => {
      const result = parseTemplateGenerateResponse(
        json({
          assistantMessage: 'Template criado',
          configuration: { header: { elements: [] } },
        }),
      );

      expect(result).toEqual({
        assistantMessage: 'Template criado',
        configuration: { header: { elements: [] } },
      });
    });

    it('rejects missing configuration objects', () => {
      expect(() =>
        parseTemplateGenerateResponse(
          json({
            assistantMessage: 'Template criado',
            configuration: null,
          }),
        ),
      ).toThrow('Estrutura inválida retornada pelo GPT-4o');
    });
  });

  describe('parseImageIntentClassification', () => {
    it('parses valid image intent classifications and clamps confidence', () => {
      const result = parseImageIntentClassification(
        json({
          category: 'targeted_edit',
          confidence: 2,
          reason: 'existing image',
        }),
      );

      expect(result).toEqual({
        category: 'targeted_edit',
        confidence: 1,
        reason: 'existing image',
      });
    });

    it('rejects unknown image intent categories', () => {
      expect(() =>
        parseImageIntentClassification(
          json({
            category: 'unknown',
            confidence: 0.9,
          }),
        ),
      ).toThrow('Categoria de intenção inválida');
    });
  });

  describe('parseTemplateLayersComposition', () => {
    const validComposition = {
      palette: {
        primary: '#111111',
        secondary: '#222222',
        dark: '#000000',
        light: '#FFFFFF',
      },
      backgroundPrompt: 'clean supermarket background',
      elements: [
        {
          id: 'el-1',
          englishPrompt: 'isolated star',
          section: 'header',
          suggestedPosition: 'right',
          suggestedSizePct: 30,
          regenerate: true,
          positionOnly: false,
        },
      ],
      bodyBackground: { type: 'solid', color: '#FFFFFF' },
      footerBackground: { type: 'solid', color: '#111111' },
      avoid: ['text'],
      styleKeywords: ['clean'],
      assistantMessagePt: 'Composição criada',
    };

    it('parses valid layer composition payloads', () => {
      const result = parseTemplateLayersComposition(json(validComposition));

      expect(result.palette.primary).toBe('#111111');
      expect(result.elements[0]).toMatchObject({
        id: 'el-1',
        section: 'header',
        suggestedSizePct: 30,
        regenerate: true,
        positionOnly: false,
      });
      expect(result.avoid).toEqual(['text']);
      expect(result.styleKeywords).toEqual(['clean']);
    });

    it('rejects invalid layer sections', () => {
      expect(() =>
        parseTemplateLayersComposition(
          json({
            ...validComposition,
            elements: [{ ...validComposition.elements[0], section: 'body' }],
          }),
        ),
      ).toThrow('Elemento de camada inválido');
    });

    it('rejects invalid background structures', () => {
      expect(() =>
        parseTemplateLayersComposition(
          json({
            ...validComposition,
            footerBackground: { type: 'gradient', color: '#111111' },
          }),
        ),
      ).toThrow('GPT-4o retornou composição inválida');
    });
  });
});
