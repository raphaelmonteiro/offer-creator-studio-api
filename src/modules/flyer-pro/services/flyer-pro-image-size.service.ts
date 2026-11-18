import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as sharp from 'sharp';
import { resolveUploadsDir } from '../../../common/config/uploads-dir';

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * A medida (largura e altura) do arquivo local de uma foto da Galeria, lida com o `sharp` (D-2 (a)): o motor usa a
 * proporção do arquivo (PU-29). Acha o arquivo pela URL da imagem sob o `UPLOAD_DEST`; arquivo que não existe ou não abre
 * devolve `null`, nunca uma medida inventada. O download de URL de fora é da change 29.
 */
@Injectable()
export class FlyerProImageSizeService {
  constructor(private readonly config: ConfigService) {}

  async measure(url: string): Promise<ImageSize | null> {
    const file = this.localFileOf(url);
    if (!file) return null;
    try {
      const { width, height, orientation } = await sharp(file).metadata();
      if (!width || !height) return null;
      // EXIF 5 a 8: a imagem é exibida girada em 90 graus, e a proporção que o card usa é a da exibição.
      return orientation && orientation >= 5 ? { width: height, height: width } : { width, height };
    } catch {
      return null;
    }
  }

  /** O caminho do arquivo sob o `UPLOAD_DEST`, ou `null` se a URL não aponta para `/uploads/` ou escapa da pasta. */
  private localFileOf(url: string): string | null {
    const uploadsDir = resolveUploadsDir(this.config.get<string>('UPLOAD_DEST'));
    const relative = pathOfUrl(url).match(/\/uploads\/+(.+)$/)?.[1];
    if (!relative) return null;
    const file = path.resolve(uploadsDir, decodeURIComponent(relative));
    return file.startsWith(uploadsDir + path.sep) ? file : null;
  }
}

/** O caminho da URL, absoluta ou relativa, sem consulta nem âncora. */
function pathOfUrl(url: string): string {
  try {
    return new URL(url, 'http://local').pathname;
  } catch {
    return '';
  }
}
