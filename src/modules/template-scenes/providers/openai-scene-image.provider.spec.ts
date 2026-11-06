import { ConfigService } from '@nestjs/config';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { OpenAiImageService } from '../../ai/openai-image.service';
import {
  PaidResponseUnreadableError,
  SCENE_INVALID_REQUEST_CODE,
  SCENE_TIMEOUT_CODE,
} from '../../../shared/providers/openai-scene-call-errors';
import {
  classifySceneProviderError,
  OpenAiSceneImageProvider,
} from './openai-scene-image.provider';
import { SceneProviderError } from './scene-image-provider';

const INPUT = {
  model: 'gpt-image-2.5-sunburst',
  prompt: 'campo verde',
  size: '1920x3840',
  quality: 'high',
  correlationId: 'corr-1',
};

function build(generateImage: jest.Mock, env: Record<string, string> = {}) {
  return new OpenAiSceneImageProvider(
    { generateImage } as unknown as OpenAiImageService,
    new ConfigService(env),
  );
}

describe('OpenAiSceneImageProvider', () => {
  it('chama o serviço no modo sceneCall com PNG, modelo e qualidade explícitos', async () => {
    const generateImage = jest.fn().mockResolvedValue({
      image: { buffer: Buffer.from('png') },
      usage: { output_tokens: 10 },
      costUsd: 0.12,
      requestId: 'req_1',
    });

    const result = await build(generateImage, { OPENAI_TIMEOUT_MS: '90000' }).generate(INPUT);

    expect(generateImage).toHaveBeenCalledWith({
      feature: 'template-scene',
      prompt: 'campo verde',
      size: '1920x3840',
      assetKind: 'template',
      model: 'gpt-image-2.5-sunburst',
      quality: 'high',
      outputFormat: 'png',
      sceneCall: { timeoutMs: 90_000, correlationId: 'corr-1' },
    });
    expect(result).toMatchObject({
      costUsd: 0.12,
      requestId: 'req_1',
      usage: { output_tokens: 10 },
    });
    expect(result.buffer.toString()).toBe('png');
  });

  it('usa 180000 ms sem OPENAI_TIMEOUT_MS', async () => {
    const generateImage = jest.fn().mockResolvedValue({ image: { buffer: Buffer.from('p') } });
    await build(generateImage).generate(INPUT);
    expect(generateImage.mock.calls[0][0].sceneCall.timeoutMs).toBe(180_000);
  });

  it('custo desconhecido vira null', async () => {
    const generateImage = jest.fn().mockResolvedValue({ image: { buffer: Buffer.from('p') } });
    const result = await build(generateImage).generate(INPUT);
    expect(result.costUsd).toBeNull();
    expect(result.requestId).toBeNull();
  });

  it('erros do serviço saem classificados', async () => {
    const generateImage = jest
      .fn()
      .mockRejectedValue(new TerminalProviderError('sem saldo', 'quota'));
    await expect(build(generateImage).generate(INPUT)).rejects.toMatchObject({
      code: 'PROVIDER_QUOTA',
    });
  });
});

describe('OpenAiSceneImageProvider: edição da imagem inteira', () => {
  const IMAGE = Buffer.from('master');
  const OK = {
    image: { buffer: Buffer.from('png') },
    usage: { output_tokens: 10 },
    costUsd: 0.035,
    requestId: 'req_edit',
  };

  it('Pedido com marcação: a master inteira e o markup vão ao serviço, sem mask', async () => {
    const editImage = jest.fn().mockResolvedValue(OK);
    const provider = new OpenAiSceneImageProvider(
      { editImage } as unknown as OpenAiImageService,
      new ConfigService({ OPENAI_TIMEOUT_MS: '60000' }),
    );
    const markup = Buffer.from('marcacao');

    await provider.edit({ ...INPUT, size: '1152x1440', image: IMAGE, markup });

    expect(editImage).toHaveBeenCalledWith({
      feature: 'template-scene',
      prompt: 'campo verde',
      imageBuffer: IMAGE,
      imageMimeType: 'image/png',
      size: '1152x1440',
      assetKind: 'template',
      model: 'gpt-image-2.5-sunburst',
      quality: 'high',
      outputFormat: 'png',
      background: 'opaque',
      sceneCall: { timeoutMs: 60_000, correlationId: 'corr-1' },
      markup: { buffer: markup },
    });
    expect(editImage.mock.calls[0][0]).not.toHaveProperty('mask');
  });

  it('sem marcação o campo markup nem vai', async () => {
    const editImage = jest.fn().mockResolvedValue(OK);
    const provider = new OpenAiSceneImageProvider(
      { editImage } as unknown as OpenAiImageService,
      new ConfigService({}),
    );
    await provider.edit({ ...INPUT, image: IMAGE });
    expect(editImage.mock.calls[0][0]).not.toHaveProperty('markup');
  });

  it('falhas da edição saem classificadas', async () => {
    const quota = new TerminalProviderError('sem saldo', 'quota');
    const provider = new OpenAiSceneImageProvider(
      {
        editImage: jest.fn().mockRejectedValue(quota),
        generateImage: jest.fn().mockRejectedValue(quota),
      } as unknown as OpenAiImageService,
      new ConfigService({}),
    );
    await expect(provider.edit({ ...INPUT, image: IMAGE })).rejects.toMatchObject({
      code: 'PROVIDER_QUOTA',
    });
  });
});

describe('classifySceneProviderError', () => {
  it.each([
    [new TerminalProviderError('q', 'quota'), 'PROVIDER_QUOTA'],
    [new TerminalProviderError('t', SCENE_TIMEOUT_CODE), 'PROVIDER_TIMEOUT'],
    [new TerminalProviderError('i', SCENE_INVALID_REQUEST_CODE), 'PROVIDER_ERROR'],
    [
      Object.assign(new Error('x'), { status: 400, code: 'content_policy_violation' }),
      'PROVIDER_CONTENT_POLICY',
    ],
    [
      Object.assign(new Error('x'), { status: 400, code: 'moderation_blocked' }),
      'PROVIDER_CONTENT_POLICY',
    ],
    [Object.assign(new Error('x'), { status: 400, code: 'invalid_value' }), 'PROVIDER_ERROR'],
    [new TransientProviderError('HTTP 503'), 'PROVIDER_ERROR'],
    [new Error('OpenAI não configurada'), 'PROVIDER_ERROR'],
    ['texto solto', 'PROVIDER_ERROR'],
    [null, 'PROVIDER_ERROR'],
  ])('%p vira %s', (error, code) => {
    expect(classifySceneProviderError(error).code).toBe(code);
  });

  it('imagem ilegível numa resposta paga vira PROVIDER_ERROR com o custo', () => {
    const classified = classifySceneProviderError(
      new PaidResponseUnreadableError('vazia', 0.12, 'r'),
    );
    expect(classified).toMatchObject({ code: 'PROVIDER_ERROR', costUsd: 0.12 });
  });

  it('erro já classificado passa como está', () => {
    const original = new SceneProviderError('PROVIDER_QUOTA', 'q');
    expect(classifySceneProviderError(original)).toBe(original);
  });
});
