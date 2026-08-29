import * as sharp from 'sharp';
import { MascotRigService } from './mascot-rig.service';
import { UploadsService } from '../../uploads/uploads.service';
import { MascotRigRole } from '../domain/rig.types';

/** Mesmo humanoide do teste do auto-rig, agora em pixels de verdade. */
const HUMANOIDE = [
  '......########......',
  '.....##########.....',
  '.....##########.....',
  '.....##########.....',
  '.....##########.....',
  '.....##########.....',
  '......########......',
  '.......######.......',
  '........####........',
  '........####........',
  '....############....',
  '..################..',
  '..################..',
  '..################..',
  '..################..',
  '..################..',
  '..################..',
  '..################..',
  '..################..',
  '....############....',
  '.......######.......',
  '.......######.......',
  '.......######.......',
  '.......######.......',
  '......########......',
  '......##....##......',
  '......##....##......',
  '......##....##......',
  '......##....##......',
  '......##....##......',
  '.....###....###.....',
  '.....###....###.....',
];

const SCALE = 8;

/**
 * Pinta o humanoide num RGBA cru. Cada região ganha uma cor distinta para os
 * testes conseguirem provar de onde cada pixel veio (e provar que a
 * cicatrização copia cor de tronco, não de braço).
 */
async function humanoidPng(): Promise<Buffer> {
  const width = HUMANOIDE[0].length * SCALE;
  const height = HUMANOIDE.length * SCALE;
  const raw = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const line = HUMANOIDE[Math.floor(y / SCALE)];
    for (let x = 0; x < width; x += 1) {
      if (line[Math.floor(x / SCALE)] !== '#') continue;
      const p = (y * width + x) * 4;
      const col = Math.floor(x / SCALE);
      // braços em vermelho puro, resto do corpo em azul puro
      const isArm = col < 5 || col > 14;
      raw[p] = isArm ? 255 : 0;
      raw[p + 1] = 0;
      raw[p + 2] = isArm ? 0 : 255;
      raw[p + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

function makeService(): { service: MascotRigService; saved: Map<string, Buffer> } {
  const saved = new Map<string, Buffer>();
  const uploads = {
    async uploadFile(file: Express.Multer.File, folder: string) {
      const url = `/uploads/${folder}/${file.originalname}`;
      saved.set(url, file.buffer);
      return {
        id: file.originalname,
        filename: file.originalname,
        url,
        mimeType: 'image/png',
        size: file.size,
      };
    },
  } as unknown as UploadsService;
  return { service: new MascotRigService(uploads), saved };
}

describe('MascotRigService — corte do mascote em peças', () => {
  jest.setTimeout(30000);

  it('desmonta o humanoide em cabeça, tronco, dois braços e duas pernas', async () => {
    const { service } = makeService();
    const rig = await service.buildRig(await humanoidPng(), 'Zé Encarte');

    const roles = rig.layers.map((l) => l.role).sort();
    expect(roles).toEqual(
      ['arm_left', 'arm_right', 'head', 'leg_left', 'leg_right', 'torso'].sort(),
    );
  });

  it('cada peça vira um PNG RGBA válido e salvo no bucket', async () => {
    const { service, saved } = makeService();
    const rig = await service.buildRig(await humanoidPng(), 'Zé Encarte');

    for (const layer of rig.layers) {
      expect(layer.url).toMatch(/^\/uploads\/mascots\/.*\.png$/);
      const buffer = saved.get(layer.url);
      expect(buffer).toBeDefined();
      const meta = await sharp(buffer).metadata();
      expect(meta.format).toBe('png');
      expect(meta.hasAlpha).toBe(true);
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
    }
  });

  it('a peça do braço contém os pixels do braço (vermelho), não do tronco', async () => {
    const { service, saved } = makeService();
    const rig = await service.buildRig(await humanoidPng(), 'Zé Encarte');
    const arm = rig.layers.find((l) => l.role === 'arm_right');

    const { data, info } = await sharp(saved.get(arm.url))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let red = 0;
    let blue = 0;
    for (let p = 0; p < info.width * info.height; p += 1) {
      const i = p * info.channels;
      if (data[i + 3] < 16) continue;
      if (data[i] > 200) red += 1;
      if (data[i + 2] > 200) blue += 1;
    }
    expect(red).toBeGreaterThan(0);
    expect(red).toBeGreaterThan(blue);
  });

  it('CICATRIZAÇÃO: o tronco cobre o buraco do braço, e com cor de tronco', async () => {
    const { service, saved } = makeService();
    const rig = await service.buildRig(await humanoidPng(), 'Zé Encarte');
    const torso = rig.layers.find((l) => l.role === 'torso');
    const arm = rig.layers.find((l) => l.role === 'arm_right');

    // o tronco curado se estende por baixo do braço
    expect(torso.rect.x + torso.rect.w).toBeGreaterThan(arm.rect.x);

    const { data, info } = await sharp(saved.get(torso.url))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let red = 0;
    let opaque = 0;
    for (let p = 0; p < info.width * info.height; p += 1) {
      const i = p * info.channels;
      if (data[i + 3] < 16) continue;
      opaque += 1;
      if (data[i] > 200) red += 1;
    }
    expect(opaque).toBeGreaterThan(0);
    // nenhum pixel de braço vazou para o tronco: a cor copiada é sempre de tronco
    expect(red).toBe(0);
  });

  it('o PNG original não é alterado — o serviço só lê', async () => {
    const { service } = makeService();
    const original = await humanoidPng();
    const before = Buffer.from(original);
    await service.buildRig(original, 'Zé Encarte');
    expect(original.equals(before)).toBe(true);
  });

  it('boca e olhos caem dentro da cabeça', async () => {
    const { service } = makeService();
    const rig = await service.buildRig(await humanoidPng(), 'Zé Encarte');
    const head = rig.layers.find((l) => l.role === 'head').rect;
    const inside = (p: { x: number; y: number }) =>
      p.x >= head.x && p.x <= head.x + head.w && p.y >= head.y && p.y <= head.y + head.h;
    expect(inside(rig.mouth.anchor)).toBe(true);
    expect(inside(rig.eyes.left)).toBe(true);
    expect(inside(rig.eyes.right)).toBe(true);
  });

  it('bloco de largura constante não ganha braços inventados', async () => {
    const { service } = makeService();
    // imagem opaca de ponta a ponta: não há degrau de ombro, então não há braço
    const quadrado = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const rig = await service.buildRig(quadrado, 'Quadrado');
    const roles = rig.layers.map((l: { role: MascotRigRole }) => l.role);
    expect(roles).toContain('torso');
    expect(roles).toContain('head');
    expect(roles).not.toContain('arm_left');
    expect(roles).not.toContain('arm_right');
  });

  it('recorte vazio (tudo transparente) é recusado', async () => {
    const { service } = makeService();
    const vazio = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    await expect(service.buildRig(vazio, 'Vazio')).rejects.toThrow(/vazio/i);
  });
});
