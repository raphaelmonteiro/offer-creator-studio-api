import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImageMetadataService } from './image-metadata.service';
import { TaxonomyService } from './taxonomy/taxonomy.service';
import {
  chatResponse,
  installFakeOpenAi,
  openAiError,
  spyOnLogger,
} from '../utils/openai-chat.testutil';

let uploadDir: string;
const IMAGE_URL = 'http://localhost:3001/uploads/arroz.jpg';

beforeAll(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-metadata-spec-'));
  fs.writeFileSync(path.join(uploadDir, 'arroz.jpg'), Buffer.from('imagem-falsa'));
});

afterAll(() => fs.rmSync(uploadDir, { recursive: true, force: true }));

function build(env: Record<string, string> = {}) {
  const taxonomy = { promptList: () => '101|Mercearia > Arroz' } as unknown as TaxonomyService;
  const service = new ImageMetadataService(
    new ConfigService({ OPENAI_API_KEY: 'sk-teste', UPLOAD_DEST: uploadDir, ...env }),
    taxonomy,
  );
  const create = installFakeOpenAi(service);
  const logs = spyOnLogger(service);
  return { service, create, logs };
}

function metadata(confidence: number) {
  return chatResponse({
    content: JSON.stringify({ title: 'ARROZ CAMIL 5KG', fieldConfidence: { title: confidence } }),
  });
}

describe('ImageMetadataService', () => {
  it('padrão novo: gpt-6.1-terra, esforço low, max_completion_tokens, json_object, detail low, sem temperature', async () => {
    const { service, create } = build();
    create.mockResolvedValue(metadata(0.9));

    const result = await service.extractFromImage(IMAGE_URL);

    expect(result?.title).toBe('ARROZ CAMIL 5KG');
    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0];
    expect(body).toStrictEqual({
      model: 'gpt-6.1-terra',
      max_completion_tokens: 4096,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: expect.stringContaining('analista de produtos') },
        {
          role: 'user',
          content: [
            { type: 'text', text: expect.stringContaining('Extraia os metadados') },
            {
              type: 'image_url',
              image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/), detail: 'low' },
            },
          ],
        },
      ],
    });
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 60_000 });
  });

  it('com OPENAI_GALLERY_VISION_MODEL=gpt-4o-mini: max_tokens 900, temperature 0.1, json_object, detail low e high', async () => {
    const { service, create } = build({ OPENAI_GALLERY_VISION_MODEL: 'gpt-4o-mini' });
    create.mockResolvedValue(metadata(0.2)).mockResolvedValueOnce(metadata(0.2));

    await service.extractFromImage(IMAGE_URL);

    expect(create).toHaveBeenCalledTimes(2);
    const [first, second] = create.mock.calls.map((call) => call[0]);
    for (const body of [first, second]) {
      expect(body).toMatchObject({
        model: 'gpt-4o-mini',
        max_tokens: 900,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('max_completion_tokens');
    }
    expect(first.messages[1].content[1].image_url.detail).toBe('low');
    expect(second.messages[1].content[1].image_url.detail).toBe('high');
  });

  it('OPENAI_FAST_TEXT_MODEL e OPENAI_TIMEOUT_MS não mudam a chamada', async () => {
    const { service, create } = build({
      OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini',
      OPENAI_TIMEOUT_MS: '180000',
    });
    create.mockResolvedValue(metadata(0.9));
    await service.extractFromImage(IMAGE_URL);
    expect(create.mock.calls[0][0].model).toBe('gpt-6.1-terra');
    expect(create.mock.calls[0][1].timeout).toBe(60_000);
  });

  describe('duas passadas', () => {
    it('confiança abaixo de 0,5 na primeira: segunda passada em high, e o resultado é o da segunda', async () => {
      const { service, create } = build();
      create.mockResolvedValueOnce(metadata(0.3)).mockResolvedValueOnce(
        chatResponse({
          content: JSON.stringify({ title: 'ARROZ MELHOR', fieldConfidence: { title: 0.9 } }),
        }),
      );

      const result = await service.extractFromImage(IMAGE_URL);

      expect(create).toHaveBeenCalledTimes(2);
      expect(result?.title).toBe('ARROZ MELHOR');
      const details = create.mock.calls.map((c) => c[0].messages[1].content[1].image_url.detail);
      expect(details).toEqual(['low', 'high']);
    });

    it('confiança a partir de 0,5: uma só passada', async () => {
      const { service, create } = build();
      create.mockResolvedValue(metadata(0.5));
      await service.extractFromImage(IMAGE_URL);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('as linhas de log das duas passadas trazem o mesmo identificador, e uma leitura nova traz outro', async () => {
      const { service, create, logs } = build();
      create
        .mockResolvedValueOnce(metadata(0.3))
        .mockResolvedValueOnce(metadata(0.9))
        .mockResolvedValueOnce(metadata(0.9));

      await service.extractFromImage(IMAGE_URL);
      await service.extractFromImage(IMAGE_URL);

      const finished = logs.log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('AI operation finished '))
        .map((l) => JSON.parse(l.slice('AI operation finished '.length)));
      expect(finished).toHaveLength(3);
      expect(finished[0].correlationId).toEqual(expect.any(String));
      expect(finished[0].correlationId).toBe(finished[1].correlationId);
      expect(finished[2].correlationId).not.toBe(finished[0].correlationId);
      expect(finished.map((l) => l.mode)).toEqual(['low', 'high', 'low']);
    });

    it('foto cuja leitura falha: a linha de falha traz o identificador, sem custo', async () => {
      const { service, create, logs } = build();
      create.mockRejectedValue(openAiError(500, 'falha'));

      await service.extractFromImage(IMAGE_URL);

      const failed = JSON.parse(
        String(logs.error.mock.calls[0][0]).slice('AI operation failed '.length),
      );
      expect(failed.correlationId).toEqual(expect.any(String));
      expect(failed).not.toHaveProperty('estimatedCostUsd');
    });

    it('segunda passada que volta nula: vale a primeira', async () => {
      const { service, create } = build();
      create
        .mockResolvedValueOnce(metadata(0.3))
        .mockResolvedValueOnce(chatResponse({ content: '' }));
      const result = await service.extractFromImage(IMAGE_URL);
      expect(result?.title).toBe('ARROZ CAMIL 5KG');
    });
  });

  describe('versão gravada', () => {
    it('no padrão novo: diferente de vision-v1-2026-06 e com gpt-6.1-terra', async () => {
      const { service, create } = build();
      create.mockResolvedValue(metadata(0.9));

      const result = await service.extractFromImage(IMAGE_URL);

      expect(result?.modelVersion).toBe('vision-v2-2026-11:gpt-6.1-terra');
      expect(service.modelVersion()).toBe('vision-v2-2026-11:gpt-6.1-terra');
      expect(result?.modelVersion).not.toBe('vision-v1-2026-06');
    });

    it('na volta pela variável a versão contém gpt-4o-mini', async () => {
      const { service, create } = build({ OPENAI_GALLERY_VISION_MODEL: 'gpt-4o-mini' });
      create.mockResolvedValue(metadata(0.9));
      const result = await service.extractFromImage(IMAGE_URL);
      expect(result?.modelVersion).toContain('gpt-4o-mini');
    });
  });

  describe('falhas', () => {
    it('JSON cortado pelo teto: aviso com a feature, o modelo e o motivo, e resultado nulo (foto failed)', async () => {
      const { service, create, logs } = build();
      create.mockResolvedValue(
        chatResponse({ content: '{"title": "ARROZ', finishReason: 'length' }),
      );

      const result = await service.extractFromImage(IMAGE_URL);

      expect(result).toBeNull();
      const warning = logs.warn.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.startsWith('AI response invalid'));
      expect(warning).toContain('"feature":"image-metadata.extract"');
      expect(warning).toContain('"model":"gpt-6.1-terra"');
      expect(warning).toContain('"reason":"truncated"');
    });

    it('prazo estourado: resultado nulo e AI operation failed no log', async () => {
      const { service, create, logs } = build();
      create.mockRejectedValue(new Error('Request timed out.'));

      await expect(service.extractFromImage(IMAGE_URL)).resolves.toBeNull();

      expect(create).toHaveBeenCalledTimes(1);
      const failed = String(logs.error.mock.calls[0][0]);
      expect(failed).toContain('AI operation failed');
      expect(failed).toContain('"model":"gpt-6.1-terra"');
    });

    it('429 do provedor: sem segunda chamada e resultado nulo', async () => {
      const { service, create } = build();
      create.mockRejectedValue(openAiError(429, 'rate limit', 'rate_limit_exceeded'));
      await expect(service.extractFromImage(IMAGE_URL)).resolves.toBeNull();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('imagem que não carrega: resultado nulo e nenhuma chamada', async () => {
      const { service, create } = build();
      await expect(
        service.extractFromImage('http://localhost:3001/uploads/inexistente.jpg'),
      ).resolves.toBeNull();
      expect(create).not.toHaveBeenCalled();
    });

    it('resposta válida não gera aviso nem linha de falha', async () => {
      const { service, create, logs } = build();
      create.mockResolvedValue(metadata(0.9));
      await service.extractFromImage(IMAGE_URL);
      expect(logs.warn).not.toHaveBeenCalled();
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it('AI_IMAGE_METADATA_ENABLED=false: nulo e nenhuma chamada', async () => {
    const { service, create } = build({ AI_IMAGE_METADATA_ENABLED: 'false' });
    expect(service.isEnabled()).toBe(false);
    await expect(service.extractFromImage(IMAGE_URL)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('semáforo existente: no máximo 4 leituras de foto ao mesmo tempo', async () => {
    const { service, create } = build();
    let running = 0;
    let peak = 0;
    create.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return metadata(0.9);
    });

    await Promise.all(Array.from({ length: 10 }, () => service.extractFromImage(IMAGE_URL)));

    expect(create).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
  });
});
