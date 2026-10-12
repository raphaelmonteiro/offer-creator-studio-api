import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { MediaAssetsService } from '../../../shared/media-assets/media-assets.service';
import { McArtService } from './mc-art.service';
import { McStorageService } from './mc-storage.service';

/** Imagem real via sharp (o service lê largura/altura e o formato do CONTEÚDO). */
async function image(width: number, height: number, format: 'png' | 'jpeg'): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  });
  return format === 'png' ? base.png().toBuffer() : base.jpeg().toBuffer();
}

function multerFile(buffer: Buffer, mimetype: string, originalname: string): Express.Multer.File {
  return {
    buffer,
    mimetype,
    originalname,
    size: buffer.length,
    fieldname: 'file',
    encoding: '7bit',
  } as Express.Multer.File;
}

describe('McArtService — POST /commercials/art (tarefa 5.1, design D9/D12)', () => {
  let save: jest.Mock;
  let storage: { saveFile: jest.Mock };
  let mediaAssets: { findOwned: jest.Mock };
  let service: McArtService;

  beforeEach(() => {
    save = jest.fn((row: Record<string, unknown>) =>
      Promise.resolve({ id: 'asset-1', createdAt: new Date(), ...row }),
    );
    const dataSource = { getRepository: jest.fn(() => ({ save })) };
    storage = {
      saveFile: jest.fn((relDir: string, name: string) =>
        Promise.resolve(`/uploads/${relDir}/${name}`),
      ),
    };
    mediaAssets = { findOwned: jest.fn() };
    service = new McArtService(
      dataSource as unknown as DataSource,
      storage as unknown as McStorageService,
      mediaAssets as unknown as MediaAssetsService,
    );
  });

  it('PNG 1080×1350 → asset video_art/imported/ready com aspecto 4:5 e URL em commercials/art/<userId>/', async () => {
    const buffer = await image(1080, 1350, 'png');
    const view = await service.upload('u1', multerFile(buffer, 'image/png', 'arte.png'));

    expect(view).toEqual({
      assetId: 'asset-1',
      width: 1080,
      height: 1350,
      aspectRatio: '4:5',
      url: expect.stringMatching(/^\/uploads\/commercials\/art\/u1\/art-\d+-[0-9a-f]{12}\.png$/),
      mimeType: 'image/png',
      fileSize: buffer.length,
    });
    expect(storage.saveFile).toHaveBeenCalledWith(
      'commercials/art/u1',
      expect.stringMatching(/^art-\d+-[0-9a-f]{12}\.png$/),
      buffer,
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        kind: 'video_art',
        origin: 'imported',
        status: 'ready',
        name: 'arte.png',
        mimeType: 'image/png',
        width: 1080,
        height: 1350,
        fileSize: String(buffer.length),
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        metadata: expect.objectContaining({ aspectRatio: '4:5', sourceMimeType: 'image/png' }),
      }),
    );
  });

  it('JPEG 1280×928 (paisagem fora dos quatro aspectos) → 16:9 pela razão largura/altura (D12)', async () => {
    const buffer = await image(1280, 928, 'jpeg');
    const view = await service.upload('u1', multerFile(buffer, 'image/jpeg', 'nini.jpg'));
    expect(view).toMatchObject({ width: 1280, height: 928, aspectRatio: '16:9' });
    expect(view.url).toMatch(/\.jpg$/);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/jpeg' }));
  });

  it('PNG 1080×1080 → 1:1 e 1080×1920 → 9:16', async () => {
    const square = await service.upload(
      'u1',
      multerFile(await image(1080, 1080, 'png'), 'image/png', 'quadrada.png'),
    );
    const story = await service.upload(
      'u1',
      multerFile(await image(1080, 1920, 'png'), 'image/png', 'story.png'),
    );
    expect(square.aspectRatio).toBe('1:1');
    expect(story.aspectRatio).toBe('9:16');
  });

  it('PDF → 400 INVALID_ART_FILE com os tipos aceitos na mensagem, sem gravar nada', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
    const promise = service.upload('u1', multerFile(pdf, 'application/pdf', 'encarte.pdf'));
    await expect(promise).rejects.toThrow(BadRequestException);
    await promise.catch((err: BadRequestException) => {
      expect(err.getResponse()).toMatchObject({
        code: 'INVALID_ART_FILE',
        message: expect.stringContaining('PNG ou JPEG'),
        details: { accepted: ['image/png', 'image/jpeg'], received: 'application/pdf' },
      });
    });
    expect(storage.saveFile).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('o conteúdo manda: PDF renomeado com mimetype image/png também é 400', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    await expect(
      service.upload('u1', multerFile(pdf, 'image/png', 'encarte.png')),
    ).rejects.toMatchObject({ response: { code: 'INVALID_ART_FILE' } });
    expect(storage.saveFile).not.toHaveBeenCalled();
  });

  it('WebP (lido pelo sharp mas fora do aceito) → 400 com o formato recebido', async () => {
    const webp = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#fff' },
    })
      .webp()
      .toBuffer();
    await expect(
      service.upload('u1', multerFile(webp, 'image/png', 'x.png')),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_ART_FILE', details: { received: 'webp' } },
    });
  });

  it('sem arquivo → 400 FILE_REQUIRED; acima de 50 MB → 400 FILE_TOO_LARGE', async () => {
    await expect(service.upload('u1', undefined)).rejects.toMatchObject({
      response: { code: 'FILE_REQUIRED' },
    });
    const big = multerFile(await image(10, 10, 'png'), 'image/png', 'big.png');
    big.size = 50 * 1024 * 1024 + 1;
    await expect(service.upload('u1', big)).rejects.toMatchObject({
      response: { code: 'FILE_TOO_LARGE' },
    });
  });

  it('findOwned: 404/403 do MediaAssetsService propagam; asset de outro kind é 404 ART_NOT_FOUND', async () => {
    mediaAssets.findOwned.mockRejectedValueOnce(new ForbiddenException());
    await expect(service.findOwned('u1', 'asset-x')).rejects.toThrow(ForbiddenException);
    mediaAssets.findOwned.mockRejectedValueOnce(new NotFoundException('Asset não encontrado'));
    await expect(service.findOwned('u1', 'asset-x')).rejects.toThrow(NotFoundException);

    mediaAssets.findOwned.mockResolvedValueOnce({ id: 'asset-k', userId: 'u1', kind: 'kit_tile' });
    await expect(service.findOwned('u1', 'asset-k')).rejects.toMatchObject({
      response: { code: 'ART_NOT_FOUND' },
    });
    expect(mediaAssets.findOwned).toHaveBeenLastCalledWith('u1', 'asset-k');
  });

  it('findOne devolve a mesma forma do upload, com o aspecto do metadata (ou recalculado)', async () => {
    const asset = {
      id: 'asset-1',
      userId: 'u1',
      kind: 'video_art',
      fileUrl: '/uploads/commercials/art/u1/a.png',
      mimeType: 'image/png',
      width: 1080,
      height: 1350,
      fileSize: '1234',
      metadata: { aspectRatio: '4:5' },
    } as unknown as AnimationAsset;
    mediaAssets.findOwned.mockResolvedValue(asset);
    expect(await service.findOne('u1', 'asset-1')).toEqual({
      assetId: 'asset-1',
      width: 1080,
      height: 1350,
      aspectRatio: '4:5',
      url: '/uploads/commercials/art/u1/a.png',
      mimeType: 'image/png',
      fileSize: 1234,
    });
    expect(McArtService.aspectRatioOf({ ...asset, metadata: {} } as AnimationAsset)).toBe('4:5');
  });
});
