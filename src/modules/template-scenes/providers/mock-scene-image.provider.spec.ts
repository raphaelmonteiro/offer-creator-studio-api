import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { MockSceneImageProvider, MOCK_MARKERS } from './mock-scene-image.provider';
import { SceneGenerateInput, SceneProviderError } from './scene-image-provider';

const input = (prompt: string, size = '256x512'): SceneGenerateInput => ({
  model: 'gpt-image-2.5-sunburst',
  prompt,
  size,
  quality: 'high',
  correlationId: 'corr',
});

function build(env: Record<string, string> = {}) {
  const sleep = jest.fn().mockResolvedValue(undefined);
  const provider = new MockSceneImageProvider(
    new ConfigService({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '0', ...env }),
    sleep,
  );
  return { provider, sleep };
}

describe('MockSceneImageProvider', () => {
  it('mesmo prompt, mesma imagem; outro prompt, outra imagem', async () => {
    const { provider } = build();
    const a = await provider.generate(input('campo verde com sol'));
    const b = await provider.generate(input('campo verde com sol'));
    const c = await provider.generate(input('mar azul com barcos'));
    expect(a.buffer.equals(b.buffer)).toBe(true);
    expect(a.buffer.equals(c.buffer)).toBe(false);
    expect(a.requestId).toBe(b.requestId);
  });

  it('gera PNG exatamente no tamanho pedido, sem custo', async () => {
    const { provider } = build();
    const result = await provider.generate(input('x', '320x640'));
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 320, height: 640 });
    expect(result.costUsd).toBe(0);
    expect(result.usage).toBeNull();
  });

  it('gera o tamanho nativo de um folheto (1920x3840)', async () => {
    const { provider } = build();
    const result = await provider.generate(input('folheto', '1920x3840'));
    expect(await sharp(result.buffer).metadata()).toMatchObject({ width: 1920, height: 3840 });
  });

  it.each([
    [MOCK_MARKERS.quota, 'PROVIDER_QUOTA'],
    [MOCK_MARKERS.timeout, 'PROVIDER_TIMEOUT'],
    [MOCK_MARKERS.content, 'PROVIDER_CONTENT_POLICY'],
  ])('%s simula a falha %s', async (marker, code) => {
    const { provider } = build();
    const error = await provider.generate(input(`campo ${marker}`)).catch((e) => e);
    expect(error).toBeInstanceOf(SceneProviderError);
    expect(error.code).toBe(code);
  });

  it('usa a latência configurada', async () => {
    const { provider, sleep } = build({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '20000' });
    await provider.generate(input('x'));
    expect(sleep).toHaveBeenCalledWith(20_000);
  });

  it('#lento alonga a espera (mínimo de 3 s, ajustável)', async () => {
    const { provider, sleep } = build();
    await provider.generate(input(`x ${MOCK_MARKERS.slow}`));
    expect(sleep).toHaveBeenLastCalledWith(3000);
    const custom = build({ TEMPLATE_SCENE_MOCK_SLOW_MS: '50' });
    await custom.provider.generate(input(`x ${MOCK_MARKERS.slow}`));
    expect(custom.sleep).toHaveBeenLastCalledWith(50);
  });

  it('latência inválida volta ao padrão de 20 s', async () => {
    const { provider, sleep } = build({ TEMPLATE_SCENE_MOCK_LATENCY_MS: 'abc' });
    await provider.generate(input('x'));
    expect(sleep).toHaveBeenCalledWith(20_000);
  });
});
