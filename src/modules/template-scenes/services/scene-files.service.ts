import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import { resolveUploadsDir } from '../../../common/config/uploads-dir';
import {
  resolveSceneUploadPath,
  SCENE_UPLOADS_URL_PREFIX,
} from '../../../shared/gc/template-scenes-gc.runner';
import { FILENAME_PATTERN, UUID_PATTERN, writeFileAtomic } from './scene-file-io';

/** Prefixo público dos arquivos da cena; o GC só apaga sob ele. */
export const SCENE_UPLOADS_PREFIX = SCENE_UPLOADS_URL_PREFIX;

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
    if (
      !UUID_PATTERN.test(sceneId) ||
      !UUID_PATTERN.test(versionId) ||
      !FILENAME_PATTERN.test(filename)
    ) {
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
    await writeFileAtomic(absolute, (temp) => fs.writeFile(temp, buffer));
    return { url, bytes: buffer.length };
  }

  /** Lê o arquivo da cena pela URL relativa (a master de onde a edição parte). */
  async read(url: string): Promise<Buffer> {
    return fs.readFile(this.absolutePath(url));
  }

  /** Apaga o arquivo (best effort: ausente não é erro). */
  async remove(url: string): Promise<void> {
    await fs.rm(this.absolutePath(url), { force: true });
  }

  /** Caminho absoluto de uma URL da cena; recusa o que não estiver sob o prefixo da cena. */
  absolutePath(url: string): string {
    const absolute = resolveSceneUploadPath(this.uploadsDir, url);
    if (!absolute) throw new Error('Caminho fora de uploads/template-scenes');
    return absolute;
  }
}
