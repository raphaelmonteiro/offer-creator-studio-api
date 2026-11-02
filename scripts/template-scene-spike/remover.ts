import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import { BackgroundRemovalService } from '../../src/modules/ai/background-removal.service';
import type { UploadsService } from '../../src/modules/uploads/uploads.service';

/** Remoção de fundo do recorte de origem. Devolve um PNG RGBA. */
export interface Remover {
  remove(png: Buffer, name: string): Promise<Buffer>;
}

/**
 * Replicate pelo `BackgroundRemovalService` do app, com um `UploadsService` de stub que grava em
 * `cutouts/` do diretório do spike: nada vai para `backend/uploads/`.
 */
export class RealRemover implements Remover {
  private readonly service: BackgroundRemovalService;

  constructor(
    token: string,
    private readonly dir: string,
  ) {
    const uploads = {
      uploadFile: async (file: Express.Multer.File, folder: string) => {
        const target = path.join(this.dir, 'cutouts', folder);
        fs.mkdirSync(target, { recursive: true });
        const full = path.join(target, file.originalname);
        fs.writeFileSync(full, file.buffer);
        return {
          id: file.originalname,
          filename: file.originalname,
          url: `file://${full}`,
          mimeType: 'image/png',
          size: file.size,
        };
      },
    } as unknown as UploadsService;
    this.service = new BackgroundRemovalService(
      new ConfigService({ REPLICATE_API_TOKEN: token }),
      uploads,
    );
  }

  async remove(png: Buffer, name: string): Promise<Buffer> {
    const file = {
      buffer: png,
      size: png.length,
      mimetype: 'image/png',
      originalname: `${name}.png`,
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;
    const { url } = await this.service.removeBackground(file, 'spike');
    return fs.readFileSync(url.replace('file://', ''));
  }
}

/** Dry-run: recorte elíptico com a cobertura pedida (≥ 0,785 vira recorte inteiro). */
export class FakeRemover implements Remover {
  constructor(private readonly coverage: number | ((name: string) => number) = 0.5) {}

  async remove(png: Buffer, name: string): Promise<Buffer> {
    const c = typeof this.coverage === 'function' ? this.coverage(name) : this.coverage;
    const meta = await sharp(png).metadata();
    const w = meta.width as number;
    const h = meta.height as number;
    if (c >= 0.99) return sharp(png).ensureAlpha().png().toBuffer();
    if (c <= 0)
      return sharp(png)
        .ensureAlpha()
        .composite([
          {
            input: Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`,
            ),
            blend: 'dest-in',
          },
        ])
        .png()
        .toBuffer();
    const s = Math.sqrt((4 * c) / Math.PI);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${(w / 2) * s}" ry="${(h / 2) * s}" fill="#fff"/></svg>`;
    return sharp(png)
      .ensureAlpha()
      .composite([{ input: Buffer.from(svg), blend: 'dest-in' }])
      .png()
      .toBuffer();
  }
}
