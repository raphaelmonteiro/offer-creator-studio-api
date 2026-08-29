import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../uploads/uploads.service';

// replicate@1.x ships an ESM default export; under CJS without esModuleInterop
// `import X from 'replicate'` resolves to `.default` which is undefined at runtime.
// Use require + fallback to handle both shapes.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ReplicateModule = require('replicate');
const Replicate: new (options: { auth: string }) => {
  run: (model: string, options: { input: Record<string, unknown> }) => Promise<unknown>;
} = ReplicateModule.default ?? ReplicateModule;

const MAX_INPUT_SIZE = 10 * 1024 * 1024;
const MODEL = '851-labs/background-remover';
const MODEL_VERSION = 'a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc';

@Injectable()
export class BackgroundRemovalService {
  private readonly logger = new Logger(BackgroundRemovalService.name);
  private readonly replicate: InstanceType<typeof Replicate> | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {
    const token = this.configService.get<string>('REPLICATE_API_TOKEN');
    this.replicate = token ? new Replicate({ auth: token }) : null;
    if (!this.replicate) {
      this.logger.warn(
        'REPLICATE_API_TOKEN não configurado — endpoint /ai/remove-background fica indisponível.',
      );
    }
  }

  isAvailable(): boolean {
    return this.replicate !== null;
  }

  /**
   * @param folder pasta do bucket onde salvar o recorte. Default `general`
   *   (comportamento histórico de `/ai/remove-background`); o módulo de
   *   mascotes passa `mascots` para manter os derivados junto do original.
   */
  async removeBackground(
    file: Express.Multer.File,
    folder: string = 'general',
  ): Promise<{ url: string }> {
    if (!this.replicate) {
      throw new BadRequestException({
        code: 'REPLICATE_NOT_CONFIGURED',
        message: 'Servidor não configurado para remoção de fundo.',
      });
    }
    if (!file || !file.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Imagem é obrigatória.',
      });
    }
    if (file.size > MAX_INPUT_SIZE) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: 'Imagem excede o limite de 10MB.',
      });
    }

    const mimeType = file.mimetype || 'image/png';
    const dataUri = `data:${mimeType};base64,${file.buffer.toString('base64')}`;

    let outputUrl: string;
    try {
      const output = await this.replicate.run(
        `${MODEL}:${MODEL_VERSION}` as `${string}/${string}:${string}`,
        { input: { image: dataUri } },
      );
      outputUrl = this.extractUrl(output);
    } catch (error) {
      this.logger.error(`Replicate falhou: ${(error as Error).message}`, (error as Error).stack);
      throw new BadRequestException({
        code: 'BACKGROUND_REMOVAL_FAILED',
        message: 'Não foi possível remover o fundo da imagem. Tente novamente.',
      });
    }

    const response = await fetch(outputUrl);
    if (!response.ok) {
      throw new BadRequestException({
        code: 'BACKGROUND_REMOVAL_DOWNLOAD_FAILED',
        message: 'Falha ao baixar imagem processada.',
      });
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const baseName =
      (file.originalname || 'imagem')
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[^a-z0-9-_]+/gi, '-')
        .slice(0, 60) || 'imagem';
    const filename = `${baseName}-nobg-${Date.now()}.png`;

    const fakeFile = {
      buffer,
      originalname: filename,
      size: buffer.length,
      mimetype: 'image/png',
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;

    const result = await this.uploadsService.uploadFile(fakeFile, folder);
    return { url: result.url };
  }

  private extractUrl(output: unknown): string {
    if (typeof output === 'string') return output;
    if (Array.isArray(output) && output.length > 0) {
      return this.extractUrl(output[0]);
    }
    if (output && typeof output === 'object') {
      const maybeUrl = output as { url?: () => URL | string; href?: string };
      if (typeof maybeUrl.url === 'function') {
        const u = maybeUrl.url();
        return typeof u === 'string' ? u : u.toString();
      }
      if (typeof maybeUrl.href === 'string') return maybeUrl.href;
    }
    throw new Error('Formato de retorno inesperado do Replicate');
  }
}
