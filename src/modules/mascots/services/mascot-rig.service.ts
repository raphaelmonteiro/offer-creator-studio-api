import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { UploadsService } from '../../uploads/uploads.service';
import { MascotRig, MascotRigRole } from '../domain/rig.types';
import {
  AlphaProfile,
  RegionBoxes,
  RigLayout,
  buildRigFromRegions,
  computeRigLayout,
  regionAt,
} from '../domain/rig-autofit';

const UPLOAD_FOLDER = 'mascots';
/** Abaixo disto o pixel é considerado transparente (bordas anti-aliased). */
const ALPHA_THRESHOLD = 16;
/** Faixa acima do pescoço que o tronco cicatriza, para a cabeça poder inclinar. */
const HEAD_HEAL_BAND = 0.08;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  count: number;
}

const emptyBox = (): Box => ({
  left: Number.POSITIVE_INFINITY,
  top: Number.POSITIVE_INFINITY,
  right: -1,
  bottom: -1,
  count: 0,
});

const growBox = (box: Box, x: number, y: number): void => {
  if (x < box.left) box.left = x;
  if (x > box.right) box.right = x;
  if (y < box.top) box.top = y;
  if (y > box.bottom) box.bottom = y;
  box.count += 1;
};

/**
 * Corte do mascote em peças (fatia 1 da Fase 3 — rig 2D).
 *
 * Em uma frase: os pixels do recorte são repartidos entre cabeça, tronco,
 * braços e pernas segundo a geometria do `rig-autofit`, e cada peça vira um PNG
 * RGBA próprio.
 *
 * O detalhe que faz a marionete funcionar é a **cicatrização do tronco**: sem
 * ela, levantar o braço revelaria um vazio recortado. A cicatrização roda numa
 * cópia à parte (os pixels originais do braço continuam intactos, porque o
 * braço também precisa deles) e preenche o buraco com a cor do pixel de tronco
 * mais próximo, achado por busca em largura. Ela nunca escreve fora da
 * silhueta original: **não inventa desenho novo, só estende pixels que já
 * existiam** — a identidade segue preservada por construção.
 */
@Injectable()
export class MascotRigService {
  private readonly logger = new Logger(MascotRigService.name);

  constructor(private readonly uploads: UploadsService) {}

  async buildRig(cutout: Buffer, mascotName: string): Promise<MascotRig> {
    const { data, info } = await sharp(cutout)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (channels < 4) {
      throw new BadRequestException({
        code: 'MASCOT_WITHOUT_ALPHA',
        message:
          'O recorte do mascote não tem transparência. Rode o recorte de fundo antes de montar o rig.',
      });
    }

    const layout = computeRigLayout(this.readAlphaProfile(data, width, height, channels));
    if (!layout) {
      throw new BadRequestException({
        code: 'MASCOT_EMPTY_CUTOUT',
        message: 'O recorte do mascote está vazio. Envie a imagem novamente.',
      });
    }

    // ── 1. reparte cada pixel opaco entre as peças ──
    const roleOf = new Int8Array(width * height).fill(-1);
    const roles: MascotRigRole[] = [];
    const roleIdx = new Map<MascotRigRole, number>();
    const boxes = new Map<MascotRigRole, Box>();

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        if (data[p * channels + 3] < ALPHA_THRESHOLD) continue;
        const role = regionAt(layout, x, y);
        let idx = roleIdx.get(role);
        if (idx === undefined) {
          idx = roles.length;
          roles.push(role);
          roleIdx.set(role, idx);
          boxes.set(role, emptyBox());
        }
        roleOf[p] = idx;
        growBox(boxes.get(role), x, y);
      }
    }

    // ── 2. cicatriza o tronco (numa cópia; os membros ficam intactos) ──
    const torsoSource = this.healTorso(roleOf, roles, roleIdx, width, height, layout);
    if (torsoSource) {
      const torsoBox = emptyBox();
      for (let p = 0; p < torsoSource.length; p += 1) {
        if (torsoSource[p] === -1) continue;
        growBox(torsoBox, p % width, (p / width) | 0);
      }
      boxes.set('torso', torsoBox);
    }

    // ── 3. corta cada peça num PNG RGBA próprio ──
    const regionBoxes: RegionBoxes = {};
    const urls: Partial<Record<MascotRigRole, string>> = {};
    for (const [role, box] of boxes) {
      const boxWidth = box.right - box.left + 1;
      const boxHeight = box.bottom - box.top + 1;
      if (boxWidth <= 0 || boxHeight <= 0 || box.count === 0) continue;

      regionBoxes[role] = { left: box.left, top: box.top, width: boxWidth, height: boxHeight };
      const raw =
        role === 'torso' && torsoSource
          ? this.extractHealedTorso(data, torsoSource, width, channels, box, boxWidth, boxHeight)
          : this.extractLayer(
              data,
              roleOf,
              roleIdx.get(role),
              width,
              channels,
              box,
              boxWidth,
              boxHeight,
            );

      const png = await sharp(raw, { raw: { width: boxWidth, height: boxHeight, channels: 4 } })
        .png()
        .toBuffer();
      urls[role] = await this.saveLayer(png, mascotName, role);
    }

    this.logger.log(
      `Rig montado para "${mascotName}": ${Object.keys(regionBoxes).length} peças ` +
        `(${Object.keys(regionBoxes).join(', ')}).`,
    );
    return buildRigFromRegions(layout, regionBoxes, urls, 'auto');
  }

  // ─────────────────────────────── internos ───────────────────────────────

  private readAlphaProfile(
    data: Buffer,
    width: number,
    height: number,
    channels: number,
  ): AlphaProfile {
    const rows: AlphaProfile['rows'] = [];
    for (let y = 0; y < height; y += 1) {
      let min = Number.POSITIVE_INFINITY;
      let max = -1;
      let count = 0;
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * channels + 3] < ALPHA_THRESHOLD) continue;
        if (x < min) min = x;
        if (x > max) max = x;
        count += 1;
      }
      rows.push(max === -1 ? null : { min, max, count });
    }
    return { width, height, rows };
  }

  /**
   * Devolve, para cada pixel, de qual pixel de tronco ele tira a cor
   * (`-1` = não faz parte do tronco cicatrizado). Busca em largura a partir da
   * borda do tronco, avançando só sobre pixels que eram membro — ou seja,
   * dentro da silhueta original.
   */
  private healTorso(
    roleOf: Int8Array,
    roles: MascotRigRole[],
    roleIdx: Map<MascotRigRole, number>,
    width: number,
    height: number,
    layout: RigLayout,
  ): Int32Array | null {
    const torsoIdx = roleIdx.get('torso');
    if (torsoIdx === undefined) return null;

    const bodyHeight = layout.bbox.bottom - layout.bbox.top + 1;
    const headHealTop = Math.max(layout.bbox.top, layout.neckY - HEAD_HEAL_BAND * bodyHeight);

    const isHole = (p: number, y: number): boolean => {
      const idx = roleOf[p];
      if (idx < 0 || idx === torsoIdx) return false;
      const role = roles[idx];
      if (role === 'arm_left' || role === 'arm_right') return true;
      if (role === 'leg_left' || role === 'leg_right') return true;
      // faixa logo acima do pescoço: aparece quando a cabeça inclina
      return role === 'head' && y >= headHealTop;
    };

    const source = new Int32Array(width * height).fill(-1);
    let queue: number[] = [];
    for (let p = 0; p < roleOf.length; p += 1) {
      if (roleOf[p] === torsoIdx) {
        source[p] = p;
        queue.push(p);
      }
    }
    if (queue.length === 0) return null;

    let filled = 0;
    while (queue.length > 0) {
      const next: number[] = [];
      for (const p of queue) {
        const x = p % width;
        const y = (p / width) | 0;
        if (x > 0) filled += this.visit(p - 1, p, y, source, isHole, next);
        if (x < width - 1) filled += this.visit(p + 1, p, y, source, isHole, next);
        if (y > 0) filled += this.visit(p - width, p, y - 1, source, isHole, next);
        if (y < height - 1) filled += this.visit(p + width, p, y + 1, source, isHole, next);
      }
      queue = next;
    }
    this.logger.debug(`Tronco cicatrizado: ${filled} pixels por extensão de borda.`);
    return source;
  }

  private visit(
    q: number,
    from: number,
    qy: number,
    source: Int32Array,
    isHole: (p: number, y: number) => boolean,
    next: number[],
  ): number {
    if (source[q] !== -1 || !isHole(q, qy)) return 0;
    source[q] = source[from];
    next.push(q);
    return 1;
  }

  /** Peça normal: mantém os pixels do próprio papel, zera o resto. */
  private extractLayer(
    data: Buffer,
    roleOf: Int8Array,
    idx: number,
    width: number,
    channels: number,
    box: Box,
    boxWidth: number,
    boxHeight: number,
  ): Buffer {
    const out = Buffer.alloc(boxWidth * boxHeight * 4);
    for (let y = 0; y < boxHeight; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        const p = (box.top + y) * width + (box.left + x);
        const to = (y * boxWidth + x) * 4;
        if (roleOf[p] !== idx) continue; // alloc já zerou o alpha
        const from = p * channels;
        out[to] = data[from];
        out[to + 1] = data[from + 1];
        out[to + 2] = data[from + 2];
        out[to + 3] = data[from + 3];
      }
    }
    return out;
  }

  /** Tronco: usa a cor do pixel-fonte, que pode ser o vizinho que cicatrizou o buraco. */
  private extractHealedTorso(
    data: Buffer,
    source: Int32Array,
    width: number,
    channels: number,
    box: Box,
    boxWidth: number,
    boxHeight: number,
  ): Buffer {
    const out = Buffer.alloc(boxWidth * boxHeight * 4);
    for (let y = 0; y < boxHeight; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        const p = (box.top + y) * width + (box.left + x);
        const src = source[p];
        if (src === -1) continue;
        const to = (y * boxWidth + x) * 4;
        const from = src * channels;
        out[to] = data[from];
        out[to + 1] = data[from + 1];
        out[to + 2] = data[from + 2];
        out[to + 3] = 255; // o miolo cicatrizado é opaco: some com a costura
      }
    }
    return out;
  }

  private async saveLayer(png: Buffer, mascotName: string, role: MascotRigRole): Promise<string> {
    const base =
      mascotName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .toLowerCase() || 'mascote';
    const upload = await this.uploads.uploadFile(
      {
        buffer: png,
        originalname: `${base}-rig-${role}.png`,
        size: png.length,
        mimetype: 'image/png',
        fieldname: 'file',
        encoding: '7bit',
      } as Express.Multer.File,
      UPLOAD_FOLDER,
    );
    return upload.url;
  }
}
