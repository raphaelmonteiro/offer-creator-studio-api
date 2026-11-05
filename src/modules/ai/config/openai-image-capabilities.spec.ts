import {
  estimateCostUsd,
  findImageModelCapabilities,
  validateImageQuality,
  validateImageSize,
} from './openai-image-capabilities';

describe('openai-image-capabilities', () => {
  describe('findImageModelCapabilities', () => {
    it('escolhe o prefixo mais longo', () => {
      expect(findImageModelCapabilities('gpt-image-2.5-sunburst')?.prefix).toBe(
        'gpt-image-2.5-sunburst',
      );
      expect(findImageModelCapabilities('gpt-image-2.5-flare-2026-09-08')?.prefix).toBe(
        'gpt-image-2.5',
      );
      expect(findImageModelCapabilities('gpt-image-2')?.prefix).toBe('gpt-image-2');
    });

    it('devolve null para modelo desconhecido', () => {
      expect(findImageModelCapabilities('dall-e-3')).toBeNull();
      expect(findImageModelCapabilities('modelo-novo')).toBeNull();
    });
  });

  describe('validateImageSize', () => {
    it('aceita 1920x3840 no 2.5 e os presets clássicos', () => {
      expect(validateImageSize('gpt-image-2.5-sunburst', '1920x3840')).toBeNull();
      expect(validateImageSize('gpt-image-2.5-sunburst', '1024x1536')).toBeNull();
    });

    it('aceita os tamanhos nativos dos formatos de impressão', () => {
      for (const size of ['3520x2336', '2496x3280', '2352x3504', '3840x2128']) {
        expect(validateImageSize('gpt-image-2.5-sunburst', size)).toBeNull();
      }
    });

    it('recusa 10x10 (lado e área)', () => {
      expect(validateImageSize('gpt-image-2.5-sunburst', '10x10')).toMatch(/múltiplos de 16/);
      expect(validateImageSize('gpt-image-2.5-sunburst', '16x16')).toMatch(/área/);
    });

    it('recusa 4000x1000 (lado fora do múltiplo) e as faixas de borda e proporção', () => {
      expect(validateImageSize('gpt-image-2.5-sunburst', '4000x1000')).not.toBeNull();
      expect(validateImageSize('gpt-image-2.5-sunburst', '4096x1024')).toMatch(/borda/);
      expect(validateImageSize('gpt-image-2.5-sunburst', '3840x1024')).toMatch(/proporção/);
    });

    it('recusa 1000x3100 (lados fora do múltiplo de 16)', () => {
      expect(validateImageSize('gpt-image-2.5-sunburst', '1000x3100')).toMatch(/múltiplos de 16/);
    });

    it('recusa área acima do máximo', () => {
      expect(validateImageSize('gpt-image-2.5-sunburst', '3840x2160')).toBeNull();
      expect(validateImageSize('gpt-image-2.5-sunburst', '3840x2176')).toMatch(/área/);
    });

    it('recusa tamanho livre em modelo de tamanhos fixos', () => {
      expect(validateImageSize('gpt-image-1.5', '1920x3840')).toMatch(/aceita só/);
      expect(validateImageSize('gpt-image-1.5', '1024x1024')).toBeNull();
    });

    it('recusa texto fora do formato', () => {
      expect(validateImageSize('gpt-image-2.5-sunburst', 'grande')).toMatch(/LARGURAxALTURA/);
    });

    it('não valida modelo desconhecido', () => {
      expect(validateImageSize('modelo-novo', '10x10')).toBeNull();
    });
  });

  describe('validateImageQuality', () => {
    it('aceita high no 2.5 e recusa xhigh no 1.5', () => {
      expect(validateImageQuality('gpt-image-2.5-sunburst', 'high')).toBeNull();
      expect(validateImageQuality('gpt-image-1.5', 'xhigh')).toMatch(/não aceita/);
    });

    it('não valida modelo desconhecido', () => {
      expect(validateImageQuality('dall-e-3', 'standard')).toBeNull();
    });
  });

  describe('estimateCostUsd', () => {
    it('calcula o custo de um usage de geração (C3 do spike)', () => {
      const usage = {
        input_tokens: 172,
        output_tokens: 4523,
        input_tokens_details: { image_tokens: 0, text_tokens: 172 },
      };
      expect(estimateCostUsd('gpt-image-2.5-sunburst', usage)).toBe(0.13655);
    });

    it('soma tokens de imagem na entrada (edição)', () => {
      const usage = {
        output_tokens: 1000,
        input_tokens_details: { image_tokens: 2000, text_tokens: 100 },
      };
      expect(estimateCostUsd('gpt-image-2.5-sunburst', usage)).toBe(0.0465);
    });

    it('sem detalhe da entrada, conta tudo como texto', () => {
      expect(
        estimateCostUsd('gpt-image-2.5-sunburst', { input_tokens: 200, output_tokens: 0 }),
      ).toBe(0.001);
    });

    it('devolve null para modelo desconhecido, sem preço e sem usage', () => {
      const usage = { input_tokens: 1, output_tokens: 1 };
      expect(estimateCostUsd('modelo-novo', usage)).toBeNull();
      expect(estimateCostUsd('gpt-image-2.5-flare', usage)).toBeNull();
      expect(estimateCostUsd('gpt-image-2.5-sunburst', undefined)).toBeNull();
    });
  });
});
