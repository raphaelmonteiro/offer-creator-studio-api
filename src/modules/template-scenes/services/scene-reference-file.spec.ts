import * as sharp from 'sharp';
import { inspectReference } from './scene-reference-file';

const file = (buffer: Buffer, mimetype: string, originalname = 'a.jpg') => ({
  buffer,
  mimetype,
  size: buffer.length,
  originalname,
});

describe('inspectReference (PV-R2)', () => {
  it('3000x4400: origem anotada e cópia JPEG de 1047x1536 (o original não é guardado)', async () => {
    const buffer = await sharp({
      create: { width: 3000, height: 4400, channels: 3, background: '#fa0' },
    })
      .jpeg()
      .toBuffer();
    const result = await inspectReference(file(buffer, 'image/jpeg', 'C:\\pasta\\junina.jpg'));
    expect(result.origin).toMatchObject({
      fileName: 'junina.jpg',
      mimeType: 'image/jpeg',
      widthPx: 3000,
      heightPx: 4400,
      bytes: buffer.length,
    });
    expect(result.reduced).toMatchObject({ width: 1047, height: 1536 });
    expect((await sharp(result.reduced.buffer).metadata()).format).toBe('jpeg');
  });

  it('a rotação EXIF vale antes de reduzir e de medir (orientação 6 gira 90 graus)', async () => {
    const buffer = await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: '#06f' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await inspectReference(file(buffer, 'image/jpeg'));
    expect(result.origin).toMatchObject({ widthPx: 1000, heightPx: 1600 });
    expect(result.reduced).toMatchObject({ width: 960, height: 1536 });
  });

  it('PNG com transparência vira JPEG de fundo branco', async () => {
    const buffer = await sharp({
      create: { width: 900, height: 900, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const result = await inspectReference(file(buffer, 'image/png', 'a.png'));
    const { data } = await sharp(result.reduced.buffer).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every((value) => value >= 250)).toBe(true);
    expect(result.origin.mimeType).toBe('image/png');
  });

  it('lado maior de exatamente 800 px passa; 799 não', async () => {
    const ok = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#111' } })
      .jpeg()
      .toBuffer();
    await expect(inspectReference(file(ok, 'image/jpeg'))).resolves.toBeDefined();
    const small = await sharp({
      create: { width: 799, height: 500, channels: 3, background: '#111' },
    })
      .jpeg()
      .toBuffer();
    await expect(inspectReference(file(small, 'image/jpeg'))).rejects.toMatchObject({
      response: { code: 'REFERENCE_INVALID' },
    });
  });

  it('sem arquivo: pede o arquivo; nome ausente vira "encarte"', async () => {
    await expect(inspectReference(undefined)).rejects.toMatchObject({
      response: { code: 'REFERENCE_INVALID', message: 'Envie o arquivo do encarte.' },
    });
    const buffer = await sharp({
      create: { width: 900, height: 900, channels: 3, background: '#111' },
    })
      .jpeg()
      .toBuffer();
    const result = await inspectReference({
      buffer,
      mimetype: 'image/jpeg',
      size: buffer.length,
    } as never);
    expect(result.origin.fileName).toBe('encarte');
  });
});
