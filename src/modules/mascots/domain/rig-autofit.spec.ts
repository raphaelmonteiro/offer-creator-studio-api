import {
  AlphaProfile,
  RIG_TUNING,
  RegionBoxes,
  buildRigFromRegions,
  computeRigLayout,
  pivotForRole,
  regionAt,
} from './rig-autofit';
import { MascotRigRole } from './rig.types';

/**
 * Monta um perfil de alpha a partir de um desenho em texto: `#` é pixel opaco,
 * qualquer outra coisa é transparente. `scale` amplia cada caractere para um
 * bloco scale×scale, para os números ficarem na ordem de grandeza de uma
 * imagem real sem tornar o teste ilegível.
 */
function profileFromShape(lines: string[], scale = 1): AlphaProfile {
  const width = Math.max(...lines.map((line) => line.length)) * scale;
  const rows: AlphaProfile['rows'] = [];
  for (const line of lines) {
    let min = Number.POSITIVE_INFINITY;
    let max = -1;
    let count = 0;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== '#') continue;
      const from = i * scale;
      const to = from + scale - 1;
      if (from < min) min = from;
      if (to > max) max = to;
      count += scale;
    }
    const row = max === -1 ? null : { min, max, count };
    for (let s = 0; s < scale; s += 1) rows.push(row);
  }
  return { width, height: rows.length, rows };
}

/** Humanoide de pé: cabeça grande, pescoço estreito, braços abertos, pernas separadas. */
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

/** "Bolha com braços": sem pescoço, sem rosto claro — o caso do risco 1 do spike. */
const BOLHA = [
  '....########....',
  '..############..',
  '.##############.',
  '################',
  '################',
  '################',
  '################',
  '################',
  '.##############.',
  '..############..',
  '....########....',
];

describe('Auto-rig heurístico (spike §3.1, fatia 1 da Fase 3)', () => {
  describe('computeRigLayout — humanoide', () => {
    const profile = profileFromShape(HUMANOIDE, 8);
    const layout = computeRigLayout(profile);

    it('acha o personagem dentro do canvas', () => {
      expect(layout).not.toBeNull();
      expect(layout.bbox.left).toBe(2 * 8);
      expect(layout.bbox.right).toBe(17 * 8 + 7);
      expect(layout.bbox.top).toBe(0);
      expect(layout.bbox.bottom).toBe(profile.height - 1);
    });

    it('encontra o pescoço na parte estreita entre cabeça e ombros', () => {
      // linhas 8 e 9 do desenho são as mais estreitas do topo
      expect(layout.neckY).toBeGreaterThanOrEqual(8 * 8);
      expect(layout.neckY).toBeLessThan(10 * 8);
    });

    it('põe os ombros logo abaixo do pescoço', () => {
      expect(layout.shoulderY).toBeGreaterThan(layout.neckY);
      expect(layout.shoulderY - layout.neckY).toBeLessThan(profile.height * 0.06);
    });

    it('acha o quadril onde as pernas se separam', () => {
      // a separação começa na linha 25 do desenho
      expect(layout.hipY).toBeGreaterThanOrEqual(24 * 8);
      expect(layout.hipY).toBeLessThan(27 * 8);
      expect(layout.hasLegs).toBe(true);
    });

    it('centra o corpo no eixo do desenho', () => {
      expect(layout.centerX).toBeCloseTo(9.5 * 8 + 3.5, 0);
    });

    it('detecta os dois braços fora das colunas do tronco', () => {
      expect(layout.hasLeftArm).toBe(true);
      expect(layout.hasRightArm).toBe(true);
      expect(layout.torsoLeft).toBeGreaterThan(layout.bbox.left);
      expect(layout.torsoRight).toBeLessThan(layout.bbox.right);
      expect(layout.torsoLeft).toBeLessThan(layout.torsoRight);
    });
  });

  describe('computeRigLayout — casos de borda', () => {
    it('recorte vazio devolve null em vez de explodir', () => {
      expect(
        computeRigLayout({ width: 10, height: 10, rows: new Array(10).fill(null) }),
      ).toBeNull();
    });

    it('personagem "bolha" sem pescoço cai no fallback de cabeça', () => {
      const profile = profileFromShape(BOLHA, 8);
      const layout = computeRigLayout(profile);
      expect(layout).not.toBeNull();
      // sem pescoço detectável, a cabeça fica na fração padrão
      const bodyHeight = layout.bbox.bottom - layout.bbox.top + 1;
      expect(layout.neckY).toBeCloseTo(layout.bbox.top + RIG_TUNING.headFallback * bodyHeight, -1);
    });

    it('personagem sem pernas não inventa perna', () => {
      const semPernas = [
        '....####....',
        '...######...',
        '....####....',
        '.....##.....',
        '...######...',
        '..########..',
        '..########..',
        '..########..',
        '..########..',
      ];
      const layout = computeRigLayout(profileFromShape(semPernas, 8));
      expect(layout.hasLegs).toBe(false);
    });

    it('personagem sem braços não inventa braço', () => {
      const semBracos = [
        '....####....',
        '...######...',
        '...######...',
        '....####....',
        '.....##.....',
        '....####....',
        '....####....',
        '....####....',
        '....####....',
        '....####....',
        '....####....',
      ];
      const layout = computeRigLayout(profileFromShape(semBracos, 8));
      expect(layout.hasLeftArm).toBe(false);
      expect(layout.hasRightArm).toBe(false);
    });
  });

  describe('regionAt — as peças ladrilham o personagem sem sobreposição', () => {
    const profile = profileFromShape(HUMANOIDE, 8);
    const layout = computeRigLayout(profile);

    const rolesFound = new Set<MascotRigRole>();
    for (let y = 0; y < profile.height; y += 1) {
      const row = profile.rows[y];
      if (!row) continue;
      for (let x = row.min; x <= row.max; x += 1) rolesFound.add(regionAt(layout, x, y));
    }

    it('produz cabeça, tronco, os dois braços e as duas pernas', () => {
      expect([...rolesFound].sort()).toEqual(
        ['arm_left', 'arm_right', 'head', 'leg_left', 'leg_right', 'torso'].sort(),
      );
    });

    it('tudo acima do pescoço é cabeça', () => {
      expect(regionAt(layout, layout.centerX, layout.neckY - 1)).toBe('head');
      expect(regionAt(layout, layout.centerX, 0)).toBe('head');
    });

    it('abaixo do pescoço, o eixo central é tronco', () => {
      expect(regionAt(layout, layout.centerX, layout.neckY + 5)).toBe('torso');
    });

    it('fora das colunas do tronco, na faixa dos ombros, é braço', () => {
      const y = layout.shoulderY + 20;
      expect(regionAt(layout, layout.torsoLeft - 5, y)).toBe('arm_left');
      expect(regionAt(layout, layout.torsoRight + 5, y)).toBe('arm_right');
    });

    it('abaixo do quadril, cada lado é uma perna', () => {
      const y = layout.hipY + 10;
      expect(regionAt(layout, layout.centerX - 10, y)).toBe('leg_left');
      expect(regionAt(layout, layout.centerX + 10, y)).toBe('leg_right');
    });

    it('é determinístico: mesmo pixel, mesma peça, sempre', () => {
      for (const [x, y] of [
        [10, 10],
        [80, 120],
        [150, 200],
      ]) {
        expect(regionAt(layout, x, y)).toBe(regionAt(layout, x, y));
      }
    });
  });

  describe('pivôs — cada peça gira na articulação certa', () => {
    it('cabeça gira no pescoço (base, centro)', () => {
      expect(pivotForRole('head')).toEqual({ x: 0.5, y: 0.97 });
    });

    it('braço gira no ombro, do lado do tronco', () => {
      // braço da esquerda da tela tem o ombro na borda DIREITA da peça
      expect(pivotForRole('arm_left').x).toBeGreaterThan(0.5);
      expect(pivotForRole('arm_right').x).toBeLessThan(0.5);
      expect(pivotForRole('arm_left').y).toBeLessThan(0.3);
      expect(pivotForRole('arm_right').y).toBeLessThan(0.3);
    });

    it('perna gira no quadril (topo) e tronco na base', () => {
      expect(pivotForRole('leg_left').y).toBeLessThan(0.2);
      expect(pivotForRole('torso').y).toBeGreaterThan(0.9);
    });
  });

  describe('buildRigFromRegions', () => {
    const profile = profileFromShape(HUMANOIDE, 8);
    const layout = computeRigLayout(profile);
    const boxes: RegionBoxes = {
      head: { left: 40, top: 0, width: 80, height: 80 },
      torso: { left: 56, top: 80, width: 48, height: 120 },
      arm_left: { left: 16, top: 88, width: 40, height: 80 },
      arm_right: { left: 104, top: 88, width: 40, height: 80 },
      leg_left: { left: 48, top: 200, width: 24, height: 56 },
      leg_right: { left: 96, top: 200, width: 24, height: 56 },
    };
    const rig = buildRigFromRegions(layout, boxes, { head: '/uploads/mascots/x/head.png' });

    it('gera uma camada por peça, ordenada por z', () => {
      expect(rig.layers).toHaveLength(6);
      const zs = rig.layers.map((l) => l.z);
      expect([...zs].sort((a, b) => a - b)).toEqual(zs);
    });

    it('braço de trás fica atrás do tronco e o da frente na frente', () => {
      const z = (role: MascotRigRole) => rig.layers.find((l) => l.role === role).z;
      expect(z('arm_left')).toBeLessThan(z('torso'));
      expect(z('torso')).toBeLessThan(z('head'));
      expect(z('head')).toBeLessThan(z('arm_right'));
    });

    it('converte as caixas para frações do canvas', () => {
      const head = rig.layers.find((l) => l.role === 'head');
      expect(head.rect.x).toBeCloseTo(40 / layout.canvas.w, 6);
      expect(head.rect.w).toBeCloseTo(80 / layout.canvas.w, 6);
      expect(head.url).toBe('/uploads/mascots/x/head.png');
    });

    it('camada sem URL ainda entra no rig (o corte vem depois)', () => {
      expect(rig.layers.find((l) => l.role === 'torso').url).toBeNull();
    });

    it('descarta caixa degenerada', () => {
      const semTronco = buildRigFromRegions(layout, {
        ...boxes,
        torso: { left: 0, top: 0, width: 0, height: 0 },
      });
      expect(semTronco.layers.find((l) => l.role === 'torso')).toBeUndefined();
    });

    it('posiciona boca e olhos DENTRO da cabeça', () => {
      const headRect = rig.layers.find((l) => l.role === 'head').rect;
      const within = (p: { x: number; y: number }) =>
        p.x > headRect.x &&
        p.x < headRect.x + headRect.w &&
        p.y > headRect.y &&
        p.y < headRect.y + headRect.h;
      expect(within(rig.mouth.anchor)).toBe(true);
      expect(within(rig.eyes.left)).toBe(true);
      expect(within(rig.eyes.right)).toBe(true);
    });

    it('olho esquerdo fica à esquerda do direito, na mesma altura', () => {
      expect(rig.eyes.left.x).toBeLessThan(rig.eyes.right.x);
      expect(rig.eyes.left.y).toBeCloseTo(rig.eyes.right.y, 6);
    });

    it('boca fica abaixo dos olhos', () => {
      expect(rig.mouth.anchor.y).toBeGreaterThan(rig.eyes.left.y);
    });

    it('marca a origem do rig e a versão do formato', () => {
      expect(rig.version).toBe(1);
      expect(rig.source).toBe('auto');
      expect(buildRigFromRegions(layout, boxes, {}, 'manual').source).toBe('manual');
    });
  });
});
