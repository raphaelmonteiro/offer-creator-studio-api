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

describe('MockSceneImageProvider: edição da imagem inteira', () => {
  const SIZE = 64;
  const solid = (color: string) =>
    sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: color } })
      .png()
      .toBuffer();

  const raw = async (png: Buffer) =>
    (await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
  const editInput = async (prompt: string) => ({
    ...input(prompt, `${SIZE}x${SIZE}`),
    image: await solid('#336699'),
  });

  it('custa zero e traz um id de requisição do mock', async () => {
    const { provider } = build();
    const result = await provider.edit(await editInput('deixa o sol mais alaranjado'));
    expect(result.costUsd).toBe(0);
    expect(result.requestId).toMatch(/^mock-/);
  });

  it('é determinístico: mesmo pedido, mesma imagem', async () => {
    const { provider } = build();
    const a = await provider.edit(await editInput('x'));
    const b = await provider.edit(await editInput('x'));
    expect(a.buffer.equals(b.buffer)).toBe(true);
  });

  it('a imagem toda muda, no mesmo tamanho', async () => {
    const { provider } = build();
    const result = await provider.edit(await editInput('deixa tudo mais quente'));
    expect(await sharp(result.buffer).metadata()).toMatchObject({ width: SIZE, height: SIZE });
    const before = await raw(await solid('#336699'));
    const after = await raw(result.buffer);
    expect(after[0]).not.toBe(before[0]);
    expect(after[after.length - 3]).not.toBe(before[before.length - 3]);
  });

  it('com markup: registra o markup recebido e altera a imagem inteira, para o diff ser real', async () => {
    const provider = new MockSceneImageProvider(
      new ConfigService({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '0' }),
    );
    const image = await solid('#336699');
    const markup = await sharp({
      create: {
        width: SIZE,
        height: SIZE,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const result = await provider.edit({
      ...input('tire o coelho', `${SIZE}x${SIZE}`),
      image,
      markup,
    });

    expect(provider.edits).toHaveLength(1);
    expect(provider.edits[0].markup).toBe(markup);
    expect(provider.edits[0].prompt).toBe('tire o coelho');
    const before = await raw(image);
    const after = await raw(result.buffer);
    let changed = 0;
    for (let i = 0; i < before.length; i += 3) {
      if (
        before[i] !== after[i] ||
        before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2]
      )
        changed += 1;
    }
    expect(changed).toBe(SIZE * SIZE);
  });

  it('sem markup o registro guarda null, e só as últimas 20 edições ficam', async () => {
    const provider = new MockSceneImageProvider(
      new ConfigService({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '0' }),
    );
    const image = await solid('#336699');
    for (let i = 0; i < 22; i += 1) {
      await provider.edit({ ...input(`pedido ${i}`, `${SIZE}x${SIZE}`), image });
    }
    expect(provider.edits).toHaveLength(20);
    expect(provider.edits[0].prompt).toBe('pedido 2');
    expect(provider.edits[19].markup).toBeNull();
  });

  it('#sem-mudanca devolve o recorte intacto', async () => {
    const { provider } = build();
    const given = await editInput(`x ${MOCK_MARKERS.noChange}`);
    const result = await provider.edit(given);
    expect(result.buffer.equals(given.image)).toBe(true);
  });

  it.each([
    [MOCK_MARKERS.quota, 'PROVIDER_QUOTA'],
    [MOCK_MARKERS.timeout, 'PROVIDER_TIMEOUT'],
  ])('a edição também simula %s', async (marker, code) => {
    const { provider } = build();
    const error = await provider.edit(await editInput(`x ${marker}`)).catch((e) => e);
    expect(error).toBeInstanceOf(SceneProviderError);
    expect(error.code).toBe(code);
  });
});
