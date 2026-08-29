import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** Timeout padrão de um passe de render (o job volta à fila via pg-boss se estourar). */
export const DEFAULT_RENDER_TIMEOUT_MS = 5 * 60 * 1000;

/** Resultado do ffprobe — o suficiente para validar um vídeo ingerido (plano-comerciais §6.8). */
export interface FfprobeResult {
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface FfmpegRunOptions {
  /** Duração alvo do output — base do cálculo de progresso via -progress. */
  durationMs: number;
  /** Callback de progresso (0–100), throttled a 1/s. */
  onProgress?: (pct: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Runner sandbox de ffmpeg — infraestrutura compartilhada (plano-comerciais
 * §11), extraída do FfmpegRenderProcessor do animations. Responsabilidades
 * REUTILIZÁVEIS: spawn com timeout, parse de `-progress pipe:1`, tempdir por
 * job, output atômico via rename e anti-path-traversal no diretório de
 * uploads. A montagem do grafo de filtros (overlay/concat) fica em cada
 * módulo (FfmpegGraphBuilder no animations; AssemblyGraphBuilder futuro no
 * commercials).
 */
@Injectable()
export class FfmpegRunner {
  constructor(private readonly config: ConfigService) {}

  /** Tempdir exclusivo do job (limpe com removeTempDir no finally). */
  createTempDir(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  async removeTempDir(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Anti-path-traversal: resolve um caminho `/uploads/...` para o caminho
   * absoluto dentro de `uploadsDir`, rejeitando qualquer escape do diretório.
   */
  resolveUploadPath(uploadsDir: string, urlPath: string): string {
    const relative = urlPath.replace(/^\/uploads\//, '');
    const filePath = path.resolve(uploadsDir, relative);
    if (!filePath.startsWith(uploadsDir + path.sep)) {
      throw new Error(`Caminho fora do diretório de uploads: ${urlPath}`);
    }
    return filePath;
  }

  /** Output atômico: escreva em `partPath` e publique com rename — retomada pós-restart nunca vê arquivo parcial. */
  finalizeOutput(partPath: string, finalPath: string): Promise<void> {
    return fs.rename(partPath, finalPath);
  }

  /**
   * `ffprobe -print_format json -show_streams -show_format` com timeout —
   * validação de mídia antes de aceitar um download (plano-comerciais §6.8:
   * "ffprobe antes de aceitar"). Erro de spawn/parse rejeita a Promise; um
   * arquivo sem stream de vídeo volta `hasVideo: false` (decisão do chamador).
   */
  probe(filePath: string, timeoutMs = 30_000): Promise<FfprobeResult> {
    return new Promise((resolve, reject) => {
      const ffprobe = this.config.get('FFPROBE_PATH', 'ffprobe');
      const child = spawn(
        ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`ffprobe excedeu ${timeoutMs / 1000}s`));
      }, timeoutMs);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-1000)));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`ffprobe saiu com código ${code}: ${stderr.slice(-300)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            streams?: Array<{
              codec_type?: string;
              width?: number;
              height?: number;
              duration?: string;
            }>;
            format?: { duration?: string };
          };
          const video = parsed.streams?.find((s) => s.codec_type === 'video');
          const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
          const durationS = Number(parsed.format?.duration ?? video?.duration ?? NaN);
          resolve({
            hasVideo: !!video,
            hasAudio: !!audio,
            width: video?.width ?? null,
            height: video?.height ?? null,
            durationMs: Number.isFinite(durationS) ? Math.round(durationS * 1000) : null,
          });
        } catch (err) {
          reject(new Error(`ffprobe devolveu JSON inválido: ${(err as Error).message}`));
        }
      });
    });
  }

  /**
   * Executa um passe do ffmpeg (`-nostdin -progress pipe:1` + args) com
   * timeout (SIGKILL) e progresso parseado de `out_time_ms`, throttled a 1/s.
   */
  run(args: string[], options: FfmpegRunOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const ffmpeg = this.config.get('FFMPEG_PATH', 'ffmpeg');
      const child = spawn(ffmpeg, ['-nostdin', '-progress', 'pipe:1', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`ffmpeg excedeu ${timeoutMs / 1000}s`));
      }, timeoutMs);

      let stderr = '';
      let lastReport = 0;
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      child.stdout.on('data', (d: Buffer) => {
        const match = /out_time_ms=(\d+)/.exec(d.toString());
        if (match && Date.now() - lastReport > 1000) {
          lastReport = Date.now();
          const pct = Math.min(
            100,
            Math.round((Number(match[1]) / 1000 / options.durationMs) * 100),
          );
          if (options.onProgress) void options.onProgress(pct).catch(() => undefined);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-500)}`));
      });
    });
  }
}
