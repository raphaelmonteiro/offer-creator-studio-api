import { ConfigService } from '@nestjs/config';
import { OpenAiImageService } from './openai-image.service';

/**
 * Snapshot (change add-template-scene-persistence, task 1.1): o corpo enviado ao SDK pelos
 * chamadores atuais (template, social, transparente, legado, prévia `flare`) NÃO pode mudar
 * quando o serviço ganhar o modo `sceneCall`. Gravado antes de qualquer mudança no serviço.
 */
const PNG_B64 = Buffer.from('imagem-falsa').toString('base64');

function buildService(env: Record<string, string> = {}) {
  const config = new ConfigService({ OPENAI_API_KEY: 'sk-teste', ...env });
  const service = new OpenAiImageService(config);
  const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });
  const edit = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });
  (service as unknown as { openai: unknown }).openai = { images: { generate, edit } };
  return { service, generate, edit };
}

const PNG_BUFFER = Buffer.from('png-de-entrada');

describe('OpenAiImageService: corpo da requisição dos chamadores atuais', () => {
  describe('generateImage', () => {
    it('preset de template (final)', async () => {
      const { service, generate } = buildService();
      await service.generateImage({
        feature: 'template',
        prompt: 'fundo de encarte',
        size: '1024x1536',
        assetKind: 'template',
      });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate.mock.calls[0]).toEqual([
        {
          model: 'gpt-image-2.5-sunburst',
          prompt: 'fundo de encarte',
          size: '1024x1536',
          quality: 'high',
          n: 1,
          background: 'opaque',
          output_format: 'jpeg',
          output_compression: 85,
        },
      ]);
    });

    it('preset social (background)', async () => {
      const { service, generate } = buildService();
      await service.generateImage({
        feature: 'social',
        prompt: 'arte social',
        size: '1024x1024',
        assetKind: 'background',
      });
      expect(generate.mock.calls[0]).toEqual([
        {
          model: 'gpt-image-2.5-sunburst',
          prompt: 'arte social',
          size: '1024x1024',
          quality: 'high',
          n: 1,
          background: 'opaque',
          output_format: 'jpeg',
          output_compression: 85,
        },
      ]);
    });

    it('preset transparente', async () => {
      const { service, generate } = buildService();
      await service.generateImage({
        feature: 'element',
        prompt: 'sol',
        size: '1024x1024',
        assetKind: 'transparent',
      });
      expect(generate.mock.calls[0]).toEqual([
        {
          model: 'gpt-image-2.5-sunburst',
          prompt: 'sol',
          size: '1024x1024',
          quality: 'high',
          n: 1,
          background: 'transparent',
          output_format: 'png',
        },
      ]);
    });

    it('preset legado (dall-e) sem campos de formato', async () => {
      const { service, generate } = buildService();
      await service.generateImage({
        feature: 'legacy',
        prompt: 'fundo antigo',
        size: '1024x1024',
        assetKind: 'legacy',
      });
      expect(generate.mock.calls[0]).toEqual([
        {
          model: 'dall-e-3',
          prompt: 'fundo antigo',
          size: '1024x1024',
          quality: 'standard',
          n: 1,
        },
      ]);
    });

    it('prévia flare (mode preview)', async () => {
      const { service, generate } = buildService();
      await service.generateImage({
        feature: 'template',
        prompt: 'prévia',
        size: '1536x1024',
        assetKind: 'template',
        mode: 'preview',
      });
      expect(generate.mock.calls[0]).toEqual([
        {
          model: 'gpt-image-2.5-flare',
          prompt: 'prévia',
          size: '1536x1024',
          quality: 'medium',
          n: 1,
          background: 'opaque',
          output_format: 'jpeg',
          output_compression: 85,
        },
      ]);
    });

    it('não repassa opções do SDK (sem segundo argumento)', async () => {
      const { service, generate } = buildService();
      await service.generateImage({
        feature: 'template',
        prompt: 'x',
        size: '1024x1024',
        assetKind: 'template',
      });
      expect(generate.mock.calls[0]).toHaveLength(1);
    });
  });

  describe('editImage', () => {
    const base = {
      feature: 'template',
      prompt: 'edite',
      imageBuffer: PNG_BUFFER,
      size: '1024x1536' as const,
    };

    it('preset de template (final), sem input_fidelity no modelo 2.5', async () => {
      const { service, edit } = buildService();
      await service.editImage({ ...base, assetKind: 'template' });
      expect(edit.mock.calls[0]).toEqual([
        {
          model: 'gpt-image-2.5-sunburst',
          image: expect.anything(),
          prompt: 'edite',
          size: '1024x1536',
          quality: 'high',
          n: 1,
          background: 'opaque',
          output_format: 'jpeg',
          output_compression: 85,
        },
      ]);
      expect(edit.mock.calls[0]).toHaveLength(1);
    });

    it('preset transparente', async () => {
      const { service, edit } = buildService();
      await service.editImage({ ...base, assetKind: 'transparent' });
      expect(edit.mock.calls[0][0]).toEqual({
        model: 'gpt-image-2.5-sunburst',
        image: expect.anything(),
        prompt: 'edite',
        size: '1024x1536',
        quality: 'high',
        n: 1,
        background: 'transparent',
        output_format: 'png',
      });
    });

    it('preset legado (dall-e) mantém background/formato do preset', async () => {
      const { service, edit } = buildService();
      await service.editImage({ ...base, assetKind: 'legacy' });
      expect(edit.mock.calls[0][0]).toEqual({
        model: 'dall-e-3',
        image: expect.anything(),
        prompt: 'edite',
        size: '1024x1536',
        quality: 'standard',
        n: 1,
      });
    });

    it('prévia flare (mode preview)', async () => {
      const { service, edit } = buildService();
      await service.editImage({ ...base, assetKind: 'template', mode: 'preview' });
      expect(edit.mock.calls[0][0]).toEqual({
        model: 'gpt-image-2.5-flare',
        image: expect.anything(),
        prompt: 'edite',
        size: '1024x1536',
        quality: 'medium',
        n: 1,
        background: 'opaque',
        output_format: 'jpeg',
        output_compression: 85,
      });
    });

    it('modelo 1.5 envia input_fidelity', async () => {
      const { service, edit } = buildService();
      await service.editImage({ ...base, assetKind: 'template', model: 'gpt-image-1.5' });
      expect(edit.mock.calls[0][0]).toMatchObject({
        model: 'gpt-image-1.5',
        input_fidelity: 'high',
      });
    });

    it('várias imagens viram lista em image', async () => {
      const { service, edit } = buildService();
      await service.editImage({
        feature: 'template',
        prompt: 'edite',
        size: '1024x1024',
        images: [
          { buffer: PNG_BUFFER, mimeType: 'image/png', filename: 'a.png' },
          { buffer: PNG_BUFFER, mimeType: 'image/png', filename: 'b.png' },
        ],
      });
      expect(Array.isArray(edit.mock.calls[0][0].image)).toBe(true);
      expect(edit.mock.calls[0][0].image).toHaveLength(2);
    });
  });

  it('o resultado devolvido mantém o formato atual', async () => {
    const { service } = buildService();
    const result = await service.generateImage({
      feature: 'template',
      prompt: 'x',
      size: '1024x1024',
      assetKind: 'template',
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        'background',
        'image',
        'mode',
        'model',
        'outputCompression',
        'outputFormat',
        'quality',
        'size',
      ].sort(),
    );
    expect(result.image.buffer.toString()).toBe('imagem-falsa');
  });
});
