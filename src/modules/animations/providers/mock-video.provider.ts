import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  ProviderStatusResult,
  ProviderSubmitResult,
  TerminalProviderError,
} from './provider.types';

/** Tamanho de saída por proporção — espelha o que os providers reais aceitam. */
const SIZE_BY_ASPECT: Record<string, { w: number; h: number }> = {
  '1:1': { w: 720, h: 720 },
  '9:16': { w: 576, h: 1024 },
  '16:9': { w: 1024, h: 576 },
  '4:5': { w: 640, h: 800 },
};

const FPS = 24;
const MOCK_DIR = 'animations/_mock';

/**
 * Provider MOCK de image-to-video (TDD i2v §4/§9 fatia 1).
 *
 * Existe para exercitar o pipeline inteiro — enfileirar, submeter, poll,
 * ingest, asset `ready`, SSE, player na tela — **sem gastar um centavo de API**
 * e sem depender de `FAL_API_KEY`.
 *
 * O vídeo é gerado com ffmpeg a partir da própria imagem de origem, com um
 * flutuar sutil. Não é uma animação de verdade e **não deve ser confundida com
 * uma**: serve para provar que a imagem atravessou o pipeline e voltou como
 * vídeo. A UI mostra o motor usado, então o usuário sabe que é mock.
 *
 * É **stateless de propósito**: o estado do job vive no arquivo em disco, não
 * num Map em memória. Se o worker reiniciar entre o submit e o poll, o job
 * continua de onde estava.
 */
@Injectable()
export class MockVideoProvider {
  private readonly logger = new Logger(MockVideoProvider.name);
  /** Latência simulada, para a UI exercitar o estado "gerando". */
  private readonly latencyMs: number;

  constructor(private readonly config: ConfigService) {
    this.latencyMs = Number(this.config.get('IMAGE_TO_VIDEO_MOCK_LATENCY_MS', '6000'));
  }

  async submitImageToVideo(params: {
    imageUrl: string;
    motionPrompt: string;
    negativePrompt?: string;
    durationS: number;
    aspectRatio?: string;
  }): Promise<ProviderSubmitResult> {
    const jobId = randomUUID();
    const size = SIZE_BY_ASPECT[params.aspectRatio ?? '1:1'] ?? SIZE_BY_ASPECT['1:1'];
    const durationS = Math.min(10, Math.max(2, params.durationS || 5));

    const dir = path.join(path.resolve(this.config.get('UPLOAD_DEST', './uploads')), MOCK_DIR);
    await fs.mkdir(dir, { recursive: true });
    const imagePath = path.join(dir, `${jobId}.png`);
    const videoPath = path.join(dir, `${jobId}.mp4`);

    await fs.writeFile(imagePath, await this.readSourceImage(params.imageUrl));
    try {
      await this.renderClip(imagePath, videoPath, size, durationS);
    } finally {
      await fs.rm(imagePath, { force: true }).catch(() => undefined);
    }

    this.logger.log(
      `[mock] job ${jobId}: ${size.w}x${size.h}, ${durationS}s — prompt com ${params.motionPrompt.length} chars`,
    );
    return { providerJobId: jobId };
  }

  async getStatus(providerJobId: string): Promise<ProviderStatusResult> {
    const videoPath = path.join(
      path.resolve(this.config.get('UPLOAD_DEST', './uploads')),
      MOCK_DIR,
      `${providerJobId}.mp4`,
    );
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(videoPath);
    } catch {
      return {
        state: 'failed',
        errorCode: 'mock_job_missing',
        errorMessage: 'Job do provider mock não encontrado no disco.',
      };
    }

    // latência simulada medida pelo próprio arquivo — nada em memória
    if (Date.now() - stat.mtimeMs < this.latencyMs) {
      return { state: 'processing' };
    }

    const buffer = await fs.readFile(videoPath);
    // data: URI porque o ingest faz `fetch(outputUrl)`; assim o mock não depende
    // de o worker conseguir alcançar o servidor HTTP por rede.
    return {
      state: 'succeeded',
      outputUrl: `data:video/mp4;base64,${buffer.toString('base64')}`,
      costUsd: 0,
    };
  }

  /** Aceita data URI, caminho /uploads/* ou URL http(s). */
  private async readSourceImage(imageUrl: string): Promise<Buffer> {
    if (imageUrl.startsWith('data:')) {
      const base64 = imageUrl.slice(imageUrl.indexOf(',') + 1);
      return Buffer.from(base64, 'base64');
    }
    if (imageUrl.startsWith('/uploads/')) {
      const uploadsDir = path.resolve(this.config.get('UPLOAD_DEST', './uploads'));
      const abs = path.resolve(uploadsDir, imageUrl.replace(/^\/uploads\//, ''));
      if (!abs.startsWith(uploadsDir + path.sep)) {
        throw new TerminalProviderError(`Caminho inválido: ${imageUrl}`, 'invalid_asset_path');
      }
      return fs.readFile(abs);
    }
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new TerminalProviderError(
        `Não foi possível ler a imagem de origem (HTTP ${response.status})`,
        'source_image_unreadable',
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Imagem parada → clipe com um flutuar sutil (deriva senoidal no crop).
   * Sem `zoompan` e sem `drawtext` de propósito: os dois são frágeis em
   * ambientes mínimos (fontes ausentes, versões de filtro).
   */
  private renderClip(
    imagePath: string,
    videoPath: string,
    size: { w: number; h: number },
    durationS: number,
  ): Promise<void> {
    const over = 1.08; // folga para o crop ter para onde derivar
    const scaleW = Math.round(size.w * over);
    const scaleH = Math.round(size.h * over);
    const filter =
      `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,` +
      `crop=${size.w}:${size.h}:` +
      `'(iw-${size.w})/2+10*sin(2*PI*t/2.5)':` +
      `'(ih-${size.h})/2+7*sin(2*PI*t/3.5)',` +
      `format=yuv420p`;

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-i',
      imagePath,
      '-t',
      String(durationS),
      '-r',
      String(FPS),
      '-vf',
      filter,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-movflags',
      '+faststart',
      '-an',
      videoPath,
    ];

    return new Promise((resolve, reject) => {
      const ffmpeg = this.config.get('FFMPEG_PATH', 'ffmpeg');
      const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });
      child.on('error', (err) =>
        reject(
          new TerminalProviderError(
            `Provider mock precisa do ffmpeg no PATH: ${err.message}`,
            'mock_ffmpeg_missing',
          ),
        ),
      );
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new TerminalProviderError(
                `ffmpeg falhou no provider mock (${code}): ${stderr.slice(-300)}`,
                'mock_render_failed',
              ),
            ),
      );
    });
  }
}
