import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { buildPosterArgs } from '../domain/mc-assembly-graph';
import { buildLastFrameArgs } from '../domain/mc-talk-chunk-ffmpeg';
import { ChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStorageService } from '../services/mc-storage.service';
import type {
  ConformedChunk,
  PublishedJoinFrame,
  PublishedVideo,
} from './mc-talk-chunk-ingest.types';

/** Publicação, no bucket, dos arquivos do trecho: fatias, trecho inteiro e quadro de junção. */
export class McTalkChunkPublisher {
  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
  ) {}

  private sceneDir(project: McProject, scene: McScene): string {
    return this.storage.sceneRelDir(project.userId, project.id, scene.idx, scene.generation);
  }

  async publishSlices(
    project: McProject,
    scenes: McScene[],
    conformed: ConformedChunk,
  ): Promise<PublishedVideo[]> {
    const stamp = Date.now();
    const out: PublishedVideo[] = [];
    for (const [i, slice] of conformed.slices.entries()) {
      const relDir = this.sceneDir(project, scenes[i]);
      out.push({
        assetId: randomUUID(),
        ...(await this.publishFile(relDir, `synced-${stamp}-c${i}`, slice.path)),
      });
    }
    return out;
  }

  /** Trecho inteiro (inspeção e referência); só existe com mais de uma fatia. */
  async publishFull(
    project: McProject,
    leader: McScene,
    conformed: ConformedChunk,
  ): Promise<PublishedVideo | null> {
    if (conformed.slices.length < 2) return null;
    const relDir = this.sceneDir(project, leader);
    return {
      assetId: randomUUID(),
      ...(await this.publishFile(relDir, `chunk-${Date.now()}`, conformed.fullPath)),
    };
  }

  /**
   * Último quadro do trecho (PNG sem perdas, tirado da última fatia: boca fechada na cauda) para o
   * trecho seguinte (D7). Só existe quando há trecho sucessor.
   */
  async publishJoinFrame(input: {
    project: McProject;
    scenes: McScene[];
    conformed: ConformedChunk;
    chunk: ChunkSnapshot;
    tempDir: string;
  }): Promise<PublishedJoinFrame | null> {
    const { project, scenes, conformed, chunk } = input;
    if (chunk.index >= chunk.count - 1) return null;
    const output = path.join(input.tempDir, 'join-frame.png');
    const last = conformed.slices[conformed.slices.length - 1];
    await this.ffmpeg.run(buildLastFrameArgs({ video: last.path, output }), {
      durationMs: 1000,
      timeoutMs: 60_000,
    });
    const png = await fs.readFile(output).catch(() => null);
    if (!png || png.length === 0) {
      throw new TerminalProviderError(
        'Não foi possível extrair o último quadro do trecho',
        'chunk_join_frame_missing',
      );
    }
    const relDir = this.sceneDir(project, scenes[0]);
    return {
      assetId: randomUUID(),
      fileUrl: await this.storage.saveFile(relDir, `join-${Date.now()}.png`, png),
      width: last.measured.width,
      height: last.measured.height,
      size: png.length,
    };
  }

  private async publishFile(relDir: string, base: string, file: string) {
    const posterPath = `${file}.poster.jpg`;
    await this.ffmpeg.run(buildPosterArgs(file, posterPath), {
      durationMs: 1000,
      timeoutMs: 60_000,
    });
    const poster = await fs.readFile(posterPath);
    const thumb = await sharp(poster).resize({ width: 320 }).jpeg({ quality: 80 }).toBuffer();
    const target = await this.storage.prepareStreamTarget(relDir, `${base}.mp4`);
    await this.storage.copyFile(file, target.partPath);
    await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
    return {
      fileUrl: target.url,
      posterUrl: await this.storage.saveFile(relDir, `${base}-poster.jpg`, poster),
      thumbUrl: await this.storage.saveFile(relDir, `${base}-thumb.jpg`, thumb),
      size: (await fs.stat(target.finalPath)).size,
    };
  }
}
