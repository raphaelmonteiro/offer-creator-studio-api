import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveUploadsDir } from '../../../common/config/uploads-dir';

/** Prefixo público dos arquivos da cena; o GC só apaga sob ele. */
export const SCENE_UPLOADS_PREFIX = '/uploads/template-scenes/';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface WrittenSceneFile {
  url: string;
  bytes: number;
}

/**
 * Grava os arquivos da cena em `uploads/template-scenes/<sceneId>/<versionId>/<arquivo>` e devolve a
 * URL relativa (sem CDN). É do módulo, não do `UploadsService`: a cena tem pasta, retenção e GC
 * próprios, e a pasta do `UploadsService` é uma lista fixa (achado 6b).
 */
@Injectable()
export class SceneFilesService {
  private readonly uploadsDir: string;

  constructor(config: ConfigService) {
    this.uploadsDir = resolveUploadsDir(config.get<string>('UPLOAD_DEST'));
  }

  /** URL relativa do arquivo (também usada para localizar o arquivo no disco). */
  urlFor(sceneId: string, versionId: string, filename: string): string {
    if (!UUID.test(sceneId) || !UUID.test(versionId) || !FILENAME.test(filename)) {
      throw new Error('Caminho de arquivo da cena inválido');
    }
    return `${SCENE_UPLOADS_PREFIX}${sceneId}/${versionId}/${filename}`;
  }

  /** Escreve por arquivo temporário + rename: nunca fica meio arquivo servido em `/uploads`. */
  async write(
    sceneId: string,
    versionId: string,
    filename: string,
    buffer: Buffer,
  ): Promise<WrittenSceneFile> {
    const url = this.urlFor(sceneId, versionId, filename);
    const absolute = this.absolutePath(url);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, buffer);
      await fs.rename(temp, absolute);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return { url, bytes: buffer.length };
  }

  /** Apaga o arquivo (best effort: ausente não é erro). */
  async remove(url: string): Promise<void> {
    await fs.rm(this.absolutePath(url), { force: true });
  }

  /** Caminho absoluto de uma URL da cena; recusa o que não estiver sob o prefixo da cena. */
  absolutePath(url: string): string {
    if (!url.startsWith(SCENE_UPLOADS_PREFIX))
      throw new Error('URL fora de uploads/template-scenes');
    const absolute = path.resolve(this.uploadsDir, url.replace(/^\/uploads\//, ''));
    const root = path.join(this.uploadsDir, 'template-scenes') + path.sep;
    if (!absolute.startsWith(root)) throw new Error('Caminho fora de uploads/template-scenes');
    return absolute;
  }
}
