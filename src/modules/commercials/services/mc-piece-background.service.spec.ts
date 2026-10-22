import { BadRequestException } from '@nestjs/common';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { McPieceBackgroundService } from './mc-piece-background.service';
import { McStorageService } from './mc-storage.service';

async function image(width: number, height: number, format: 'png' | 'jpeg' | 'webp' = 'png') {
  const pipeline = sharp({ create: { width, height, channels: 3, background: '#336699' } });
  return pipeline.toFormat(format).toBuffer();
}

const file = (buffer: Buffer, mimetype: string, originalname = 'fundo.png') =>
  ({ buffer, mimetype, originalname, size: buffer.length }) as Express.Multer.File;

/** Tarefa 7.3/6.6 — fundo enviado para a peça vira asset `piece_background`. */
describe('McPieceBackgroundService — POST /commercials/pieces/backgrounds', () => {
  let save: jest.Mock;
  let storage: { saveFile: jest.Mock };
  let service: McPieceBackgroundService;

  beforeEach(() => {
    save = jest.fn((row: Record<string, unknown>) => Promise.resolve({ id: 'bg-asset', ...row }));
    storage = {
      saveFile: jest.fn((relDir: string, name: string) =>
        Promise.resolve(`/uploads/${relDir}/${name}`),
      ),
    };
    service = new McPieceBackgroundService(
      { getRepository: jest.fn(() => ({ save })) } as unknown as DataSource,
      storage as unknown as McStorageService,
    );
  });

  it('JPEG 1600×900 → asset piece_background/imported/ready em commercials/pieces/<userId>/ com dimensões', async () => {
    const buffer = await image(1600, 900, 'jpeg');
    const view = await service.upload('u1', file(buffer, 'image/jpeg', 'praia.jpg'));
    expect(view).toEqual({
      assetId: 'bg-asset',
      url: expect.stringMatching(/^\/uploads\/commercials\/pieces\/u1\/bg-\d+-[0-9a-f]{12}\.jpg$/),
      width: 1600,
      height: 900,
      mimeType: 'image/jpeg',
    });
    expect(storage.saveFile).toHaveBeenCalledWith(
      'commercials/pieces/u1',
      expect.any(String),
      buffer,
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        kind: 'piece_background',
        status: 'ready',
        origin: 'imported',
        name: 'praia.jpg',
        width: 1600,
        height: 900,
        fileSize: String(buffer.length),
      }),
    );
  });

  it('WebP é aceito; o conteúdo manda sobre o mimetype (PDF renomeado → 400 INVALID_IMAGE_FILE)', async () => {
    const webp = await service.upload(
      'u1',
      file(await image(800, 600, 'webp'), 'image/webp', 'x.webp'),
    );
    expect(webp.mimeType).toBe('image/webp');
    await expect(
      service.upload('u1', file(Buffer.from('%PDF-1.4 ...'), 'image/png', 'fake.png')),
    ).rejects.toMatchObject({ response: { code: 'INVALID_IMAGE_FILE' } });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('sem arquivo → 400 FILE_REQUIRED; acima de 50 MB → 400 FILE_TOO_LARGE (nada gravado)', async () => {
    await expect(service.upload('u1', undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.upload('u1', undefined)).rejects.toMatchObject({
      response: { code: 'FILE_REQUIRED' },
    });
    const huge = {
      buffer: Buffer.alloc(50 * 1024 * 1024 + 1),
      mimetype: 'image/png',
      originalname: 'g.png',
    };
    await expect(service.upload('u1', huge as Express.Multer.File)).rejects.toMatchObject({
      response: { code: 'FILE_TOO_LARGE' },
    });
    expect(storage.saveFile).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
