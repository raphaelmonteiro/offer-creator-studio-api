import * as path from 'path';
import { FORMATS } from './formats';
import type { FormatSpec } from './formats';
import { loadRgb } from './image';
import type { Img } from './image';
import * as fs from 'fs';
import type { CasesFile } from './types';

export interface SceneCtx {
  id: string;
  img: Img;
  format: FormatSpec;
}

/** Carrega as cenas geradas na fase 1 (uma vez cada). */
export class SceneStore {
  private readonly cache = new Map<string, SceneCtx>();

  constructor(
    private readonly dir: string,
    private readonly cases: CasesFile,
  ) {}

  async get(sceneId: string): Promise<SceneCtx> {
    const hit = this.cache.get(sceneId);
    if (hit) return hit;
    const scene = this.cases.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new Error(`Cena desconhecida: ${sceneId}`);
    const file = path.join(this.dir, 'scenes', `${sceneId}.png`);
    if (!fs.existsSync(file))
      throw new Error(`Cena ${sceneId} ausente em ${file}: rode generate antes`);
    const ctx = {
      id: sceneId,
      img: await loadRgb(fs.readFileSync(file)),
      format: FORMATS[scene.formatId],
    };
    this.cache.set(sceneId, ctx);
    return ctx;
  }
}
