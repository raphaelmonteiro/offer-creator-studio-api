import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Layout de storage do pipeline (plano-comerciais §6.6):
 *
 *   /uploads/commercials/{userId}/{projectId}/scenes/{idx}/g{gen}/  keyframe, voice, synced
 *   /uploads/commercials/{userId}/{projectId}/final/v{n}/           final.mp4, poster, thumb
 *   /uploads/commercials/mock-jobs/                                 clipes do provider mock
 *
 * Escrita ATÔMICA (arquivo .part + rename — retomada pós-restart nunca vê
 * parcial) e leitura com anti-path-traversal (mesma guarda do FfmpegRunner).
 */
@Injectable()
export class McStorageService {
  constructor(private readonly config: ConfigService) {}

  uploadsDir(): string {
    return path.resolve(this.config.get<string>('UPLOAD_DEST', './uploads'));
  }

  /** Diretório (relativo a /uploads) dos artefatos de uma cena/geração. */
  sceneRelDir(userId: string, projectId: string, idx: number, generation: number): string {
    return `commercials/${userId}/${projectId}/scenes/${idx}/g${generation}`;
  }

  finalRelDir(userId: string, projectId: string, version: number): string {
    return `commercials/${userId}/${projectId}/final/v${version}`;
  }

  /**
   * Cache de trilhas (v1-B1): a faixa é genérica (prompt fixo + duração), sem
   * conteúdo de usuário — por isso o cache é GLOBAL, e não por usuário: o
   * mesmo comprimento serve todos os projetos e o custo do Eleven Music é
   * pago uma vez só.
   */
  musicCacheRelDir(): string {
    return 'commercials/music-cache';
  }

  mockJobsAbsDir(): string {
    return path.join(this.uploadsDir(), 'commercials', 'mock-jobs');
  }

  mockJobAbsPath(jobId: string): string {
    // jobId é UUID gerado por nós; o basename barra qualquer tentativa de path.
    return path.join(this.mockJobsAbsDir(), `${path.basename(jobId)}.mp4`);
  }

  /** Grava buffer em /uploads/{relDir}/{name} com .part+rename. Retorna a URL pública. */
  async saveFile(relDir: string, name: string, data: Buffer): Promise<string> {
    const dir = path.join(this.uploadsDir(), relDir);
    await fs.mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, name);
    const partPath = `${finalPath}.part`;
    await fs.writeFile(partPath, data);
    await fs.rename(partPath, finalPath);
    return `/uploads/${relDir}/${name}`;
  }

  /** Caminho absoluto de gravação (streams grandes): garante o dir e retorna {partPath, finalPath, url}. */
  async prepareStreamTarget(
    relDir: string,
    name: string,
  ): Promise<{ partPath: string; finalPath: string; url: string }> {
    const dir = path.join(this.uploadsDir(), relDir);
    await fs.mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, name);
    return { partPath: `${finalPath}.part`, finalPath, url: `/uploads/${relDir}/${name}` };
  }

  /** Resolve uma URL /uploads/* (ou absoluta contendo /uploads/) para caminho no disco, com guarda. */
  absoluteFromUrl(url: string): string | null {
    const marker = '/uploads/';
    const index = url.indexOf(marker);
    const uploadsPath = url.startsWith('/uploads/') ? url : index >= 0 ? url.slice(index) : null;
    if (!uploadsPath) return null;
    const uploadsDir = this.uploadsDir();
    const filePath = path.resolve(uploadsDir, uploadsPath.replace(/^\/uploads\//, ''));
    if (!filePath.startsWith(uploadsDir + path.sep)) return null;
    return filePath;
  }

  /** Lê um arquivo do bucket local pela URL persistida; null se fora do bucket/ausente. */
  async readUploadsFile(url: string): Promise<Buffer | null> {
    const filePath = this.absoluteFromUrl(url);
    if (!filePath) return null;
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }
}
