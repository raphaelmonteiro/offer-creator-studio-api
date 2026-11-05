import * as sharp from 'sharp';
import { buildSceneOutputs } from './scene-output';

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#4a8' } })
    .png()
    .toBuffer();

describe('buildSceneOutputs', () => {
  it('master PNG intacta e prévia WebP com 1024 px no lado maior (retrato)', async () => {
    const source = await png(1920, 3840);
    const outputs = await buildSceneOutputs(source);

    expect(outputs.master).toMatchObject({ filename: 'master.png', width: 1920, height: 3840 });
    expect(outputs.master.buffer.equals(source)).toBe(true);
    expect(outputs.preview).toMatchObject({ filename: 'preview.webp', width: 512, height: 1024 });
    expect(await sharp(outputs.preview.buffer).metadata()).toMatchObject({
      format: 'webp',
      height: 1024,
    });
  });

  it('paisagem: 1024 px na largura', async () => {
    const outputs = await buildSceneOutputs(await png(3520, 2336));
    expect(outputs.preview.width).toBe(1024);
    expect(outputs.preview.height).toBe(680);
  });

  it('imagem pequena não é ampliada', async () => {
    const outputs = await buildSceneOutputs(await png(300, 200));
    expect(outputs.preview).toMatchObject({ width: 300, height: 200 });
  });

  it('recusa o que não é PNG', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    await expect(buildSceneOutputs(jpeg)).rejects.toThrow('PNG válida');
    await expect(buildSceneOutputs(Buffer.from('nada'))).rejects.toThrow();
  });
});
