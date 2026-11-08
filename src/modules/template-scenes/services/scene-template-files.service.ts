import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { resolveUploadsDir } from '../../../common/config/uploads-dir';
import { SceneFilesService } from './scene-files.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DEFAULT_CDN_URL = 'http://localhost:3000/uploads';

/**
 * Arquivos do template de cena em `uploads/templates/scene-<sceneId>/` (PV-3): uma pasta nova por projeção
 * pictórica (`<syncId>/`) e as cópias das logos em `logos/<assetId>.<ext>`. Ficam fora do GC das cenas e nunca são
 * apagados aqui, porque os encartes guardam as URLs. As URLs usam `CDN_URL`, como as dos demais templates.
 */
@Injectable()
export class SceneTemplateFilesService {
  private readonly uploadsDir: string;
  private readonly cdnUrl: string;

  constructor(
    config: ConfigService,
    private readonly sceneFiles: SceneFilesService,
  ) {
    this.uploadsDir = resolveUploadsDir(config.get<string>('UPLOAD_DEST'));
    this.cdnUrl = config.get<string>('CDN_URL', DEFAULT_CDN_URL).replace(/\/+$/, '');
  }

  /** Grava um arquivo da projeção (temporário + rename) e devolve a URL pública. */
  async writeProjection(
    sceneId: string,
    syncId: string,
    filename: string,
    buffer: Buffer,
  ): Promise<string> {
    const relative = this.relative(sceneId, syncId, filename);
    await this.writeAtomic(relative, buffer);
    return this.publicUrl(relative);
  }

  /**
   * Copia a logo da cena para a pasta do template e devolve a URL. A cópia é por `assetId` (o arquivo de um asset
   * nunca muda): se já existe, é reaproveitada, sem gravar nada.
   */
  async copyLogo(sceneId: string, asset: { id: string; url: string }): Promise<string> {
    const extension =
      path
        .extname(asset.url)
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, '') || '.png';
    const relative = this.relative(sceneId, 'logos', `${asset.id}${extension}`);
    const absolute = this.absolute(relative);
    if (!(await exists(absolute))) {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const temp = `${absolute}.${randomUUID()}.tmp`;
      try {
        await pipeline(
          createReadStream(this.sceneFiles.absolutePath(asset.url)),
          createWriteStream(temp),
        );
        await fs.rename(temp, absolute);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    return this.publicUrl(relative);
  }

  /** Cria uma pasta de projeção nova (`syncId` = uuid). */
  newSyncId(): string {
    return randomUUID();
  }

  private relative(sceneId: string, folder: string, filename: string): string {
    const folderOk = folder === 'logos' || UUID.test(folder);
    if (!UUID.test(sceneId) || !folderOk || !FILENAME.test(filename)) {
      throw new Error('Caminho de arquivo do template da cena inválido');
    }
    return `templates/scene-${sceneId}/${folder}/${filename}`;
  }

  private absolute(relative: string): string {
    return path.join(this.uploadsDir, relative);
  }

  private publicUrl(relative: string): string {
    return `${this.cdnUrl}/${relative}`;
  }

  private async writeAtomic(relative: string, buffer: Buffer): Promise<void> {
    const absolute = this.absolute(relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, buffer);
      await fs.rename(temp, absolute);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
