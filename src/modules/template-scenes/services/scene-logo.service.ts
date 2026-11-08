import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { SCENE_LIMITS } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { logoInvalid, noCurrentVersion, sceneNotFound } from '../scene.errors';
import { parseFaceKey, resolveFace } from './scene-faces';
import { SceneFilesService } from './scene-files.service';

const LOGO_FORMATS: Readonly<Record<string, string>> = { png: 'png', jpeg: 'jpg', webp: 'webp' };
const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const TYPE_MESSAGE = 'O logo precisa ser PNG, JPEG ou WebP (SVG não é aceito).';

export interface UploadedLogo {
  assetId: string;
  url: string;
  width: number;
  height: number;
}

/** Logo por upload: PNG/JPEG/WebP até 10 MB, conferido pelo conteúdo e não só pelo cabeçalho. */
@Injectable()
export class SceneLogoService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: SceneFilesService,
  ) {}

  async upload(
    sceneId: string,
    file: Pick<Express.Multer.File, 'buffer' | 'mimetype' | 'size'> | undefined,
    face?: unknown,
  ): Promise<UploadedLogo> {
    const faceKey = parseFaceKey(face); // 400 antes de ler o arquivo
    const image = await this.inspect(file);
    const scene = await this.dataSource.manager.findOne(TemplateScene, { where: { id: sceneId } });
    if (!scene) throw sceneNotFound();
    const target = await resolveFace(this.dataSource.manager, scene, faceKey);
    // O asset precisa de uma versão que o "criou" (FK); o logo vai para a mais recente da face.
    const version = await this.dataSource.manager.findOne(TemplateSceneVersion, {
      where: { sceneId, faceIndex: target.index },
      order: { number: 'DESC' },
    });
    if (!version) throw noCurrentVersion();

    const assetId = randomUUID();
    const written = await this.files.write(
      sceneId,
      version.id,
      `logo-${assetId}.${image.extension}`,
      image.buffer,
    );
    try {
      await this.dataSource.manager.insert(TemplateSceneAsset, {
        id: assetId,
        versionId: version.id,
        sceneId,
        role: 'logo',
        url: written.url,
        width: image.width,
        height: image.height,
        bytes: written.bytes,
      });
    } catch (error) {
      await this.files.remove(written.url).catch(() => undefined);
      throw error;
    }
    return { assetId, url: written.url, width: image.width, height: image.height };
  }

  /** Tamanho, tipo do cabeçalho e formato real da imagem; nada é gravado antes de passar. */
  private async inspect(
    file: Pick<Express.Multer.File, 'buffer' | 'mimetype' | 'size'> | undefined,
  ): Promise<{ buffer: Buffer; extension: string; width: number; height: number }> {
    if (!file?.buffer?.length) throw logoInvalid('Envie um arquivo de imagem.');
    if (file.buffer.length > SCENE_LIMITS.logoMaxBytes) {
      throw logoInvalid('O logo passa de 10 MB.');
    }
    if (!LOGO_MIME_TYPES.includes(file.mimetype)) throw logoInvalid(TYPE_MESSAGE);
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(file.buffer).metadata();
    } catch {
      throw logoInvalid('Não foi possível ler a imagem do logo.');
    }
    const extension = LOGO_FORMATS[metadata.format ?? ''];
    if (!extension) throw logoInvalid(TYPE_MESSAGE);
    if (!metadata.width || !metadata.height)
      throw logoInvalid('Não foi possível ler a imagem do logo.');
    return { buffer: file.buffer, extension, width: metadata.width, height: metadata.height };
  }
}
