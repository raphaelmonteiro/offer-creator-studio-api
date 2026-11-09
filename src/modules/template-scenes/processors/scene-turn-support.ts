import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { SceneFilesService } from '../services/scene-files.service';
import { buildSceneOutputs, SceneOutputs } from '../services/scene-output';
import { CompleteExtra, SceneTurnState, StoredFile, TurnContext } from './scene-turn-state';

const DEFAULT_MODEL = 'gpt-image-2.6-sunburst';
const DEFAULT_QUALITY = 'high';
/** Lado maior das imagens inteiras que vão ao juiz (JPEG, `detail: high`, como no teste da Etapa 0). */
const JUDGE_EDGE = 1536;

/** Peças que os tratadores de cada operação compartilham: modelo, qualidade, disco e o fechamento da versão. */
@Injectable()
export class SceneTurnSupport {
  constructor(
    readonly state: SceneTurnState,
    private readonly files: SceneFilesService,
    private readonly config: ConfigService,
  ) {}

  model(): string {
    return this.config.get<string>('TEMPLATE_SCENE_IMAGE_MODEL', DEFAULT_MODEL);
  }

  generateQuality(): string {
    return this.config.get<string>('TEMPLATE_SCENE_IMAGE_QUALITY', DEFAULT_QUALITY);
  }

  editQuality(): string {
    return this.config.get<string>('TEMPLATE_SCENE_EDIT_QUALITY', DEFAULT_QUALITY);
  }

  /** Master da versão de origem, ou `null` se ela não está em disco. */
  async readMaster(ctx: TurnContext): Promise<Buffer | null> {
    const url = ctx.parent?.masterUrl;
    if (!url) return null;
    try {
      return await this.files.read(url);
    } catch {
      return null;
    }
  }

  /** Arquivo da cena pela URL (o encarte reduzido da referência), ou `null` se não está em disco. */
  async readFile(url: string | null | undefined): Promise<Buffer | null> {
    if (!url) return null;
    try {
      return await this.files.read(url);
    } catch {
      return null;
    }
  }

  /** Reduz uma imagem inteira para o juiz: JPEG até 1.536 px. */
  judgeImage(png: Buffer): Promise<Buffer> {
    return sharp(png)
      .resize({ width: JUDGE_EDGE, height: JUDGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  async removeFiles(stored: StoredFile[]): Promise<void> {
    await Promise.all(stored.map((file) => this.files.remove(file.url).catch(() => undefined)));
  }

  private async storeOutputs(
    ctx: TurnContext,
    outputs: SceneOutputs,
  ): Promise<{ master: StoredFile; preview: StoredFile }> {
    const write = async (file: SceneOutputs['master']): Promise<StoredFile> => {
      const written = await this.files.write(
        ctx.sceneId,
        ctx.versionId,
        file.filename,
        file.buffer,
      );
      return { url: written.url, bytes: written.bytes, width: file.width, height: file.height };
    };
    return { master: await write(outputs.master), preview: await write(outputs.preview) };
  }

  /**
   * Fecha a versão com uma imagem nova: confere o cancelamento (resultado descartado, custo já
   * gravado), gera master e prévia, grava os arquivos e completa. Se a versão não ficou `ready`
   * (cancelada durante a gravação), apaga os arquivos.
   */
  async finishWithImage(ctx: TurnContext, png: Buffer, extra: CompleteExtra): Promise<void> {
    if (await this.state.isCancelRequested(ctx)) {
      await this.state.cancel(ctx);
      return;
    }
    if (!(await this.state.advance(ctx, 'saving'))) return;
    const stored = await this.storeOutputs(ctx, await buildSceneOutputs(png));
    const outcome = await this.state.complete(ctx, stored, extra);
    if (outcome !== 'ready') await this.removeFiles([stored.master, stored.preview]);
  }
}
