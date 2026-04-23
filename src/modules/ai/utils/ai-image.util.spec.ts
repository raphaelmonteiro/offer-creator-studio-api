import {
  extensionFromMimeType,
  materializeGeneratedImage,
  selectImageSizeByAspectRatio,
} from './ai-image.util';

describe('ai-image.util', () => {
  describe('selectImageSizeByAspectRatio', () => {
    it('selects the closest supported size without threshold overrides', () => {
      expect(selectImageSizeByAspectRatio(9, 16)).toBe('1024x1536');
      expect(selectImageSizeByAspectRatio(1, 1)).toBe('1024x1024');
      expect(selectImageSizeByAspectRatio(16, 9)).toBe('1536x1024');
    });

    it('uses explicit portrait and landscape thresholds when provided', () => {
      expect(
        selectImageSizeByAspectRatio(10, 16, {
          portraitMaxRatio: 0.77,
          landscapeMinRatio: 1.3,
        }),
      ).toBe('1024x1536');
      expect(
        selectImageSizeByAspectRatio(10, 10, {
          portraitMaxRatio: 0.77,
          landscapeMinRatio: 1.3,
        }),
      ).toBe('1024x1024');
      expect(
        selectImageSizeByAspectRatio(16, 10, {
          portraitMaxRatio: 0.77,
          landscapeMinRatio: 1.3,
        }),
      ).toBe('1536x1024');
    });
  });

  describe('materializeGeneratedImage', () => {
    it('materializes base64 image payloads without network access', async () => {
      const payload = Buffer.from('generated-image').toString('base64');

      const result = await materializeGeneratedImage({ b64_json: payload }, 'image/jpeg');

      expect(result.buffer.toString()).toBe('generated-image');
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.extension).toBe('.jpg');
      expect(result.sourceType).toBe('base64');
    });

    it('materializes data URLs without network access', async () => {
      const payload = Buffer.from('data-url-image').toString('base64');

      const result = await materializeGeneratedImage(`data:image/png;base64,${payload}`);

      expect(result.buffer.toString()).toBe('data-url-image');
      expect(result.mimeType).toBe('image/png');
      expect(result.extension).toBe('.png');
      expect(result.sourceType).toBe('data-url');
    });

    it('rejects empty image payloads', async () => {
      await expect(materializeGeneratedImage(null)).rejects.toThrow('Imagem gerada vazia');
    });
  });

  describe('extensionFromMimeType', () => {
    it('maps supported image mime types and falls back to png', () => {
      expect(extensionFromMimeType('image/jpeg')).toBe('.jpg');
      expect(extensionFromMimeType('image/webp; charset=binary')).toBe('.webp');
      expect(extensionFromMimeType('application/octet-stream')).toBe('.png');
    });
  });
});
