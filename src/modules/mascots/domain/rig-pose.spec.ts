import {
  POSE_LIMITS,
  RIG_GESTURES,
  RigGesture,
  isRigGesture,
  resolvePose,
  samplePose,
} from './rig-pose';
import { MascotRig, MascotRigRole } from './rig.types';

const rig = (): MascotRig => ({
  version: 1,
  canvas: { w: 600, h: 800 },
  layers: [
    {
      id: 'arm_left',
      role: 'arm_left',
      url: 'a.png',
      rect: { x: 0.1, y: 0.4, w: 0.15, h: 0.3 },
      z: 10,
      pivot: { x: 0.85, y: 0.12 },
      visible: true,
    },
    {
      id: 'torso',
      role: 'torso',
      url: 't.png',
      rect: { x: 0.3, y: 0.4, w: 0.4, h: 0.4 },
      z: 20,
      pivot: { x: 0.5, y: 0.98 },
      visible: true,
    },
    {
      id: 'head',
      role: 'head',
      url: 'h.png',
      rect: { x: 0.25, y: 0.05, w: 0.5, h: 0.35 },
      z: 30,
      pivot: { x: 0.5, y: 0.97 },
      visible: true,
    },
    {
      id: 'arm_right',
      role: 'arm_right',
      url: 'r.png',
      rect: { x: 0.75, y: 0.4, w: 0.15, h: 0.3 },
      z: 40,
      pivot: { x: 0.15, y: 0.12 },
      visible: true,
    },
  ],
  mouth: {
    anchor: { x: 0.5, y: 0.28 },
    width: 0.12,
    height: 0.06,
    mode: 'procedural',
    openScale: 2.2,
  },
  eyes: {
    left: { x: 0.42, y: 0.2 },
    right: { x: 0.58, y: 0.2 },
    radius: 0.03,
    blinkEveryMs: [2800, 5200],
  },
  source: 'auto',
});

describe('Motor de pose do rig — cada peça gira na própria articulação', () => {
  describe('catálogo de gestos', () => {
    it('tem os 6 gestos da v1', () => {
      expect(RIG_GESTURES).toHaveLength(6);
      expect([...RIG_GESTURES].sort()).toEqual(
        ['dance', 'idle', 'jump', 'point', 'talk', 'wave'].sort(),
      );
    });

    it('guarda de tipo aceita só gesto conhecido', () => {
      expect(isRigGesture('dance')).toBe(true);
      expect(isRigGesture('moonwalk')).toBe(false);
    });
  });

  describe('limites de craft — o mascote se mexe sem deformar a marca', () => {
    const limits: Record<MascotRigRole, number> = {
      head: POSE_LIMITS.maxHeadDeg,
      torso: POSE_LIMITS.maxTorsoDeg,
      arm_left: POSE_LIMITS.maxArmDeg,
      arm_right: POSE_LIMITS.maxArmDeg,
      leg_left: POSE_LIMITS.maxLegDeg,
      leg_right: POSE_LIMITS.maxLegDeg,
      prop: POSE_LIMITS.maxArmDeg,
    };

    it.each(RIG_GESTURES)('%s respeita todos os limites ao longo do tempo', (gesture) => {
      for (let t = 0; t <= 6000; t += 40) {
        const pose = samplePose(gesture, t);
        for (const role of Object.keys(pose.rotate) as MascotRigRole[]) {
          expect(Math.abs(pose.rotate[role])).toBeLessThanOrEqual(limits[role] + 1e-6);
        }
        expect(pose.scale).toBeLessThanOrEqual(1.1);
        expect(pose.scale).toBeGreaterThanOrEqual(0.9);
        expect(Math.abs(pose.offsetY)).toBeLessThanOrEqual(POSE_LIMITS.maxHopY + 1e-6);
        expect(pose.mouthOpen).toBeGreaterThanOrEqual(0);
        expect(pose.mouthOpen).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('os gestos fazem o que prometem', () => {
    const maxOver = (gesture: RigGesture, role: MascotRigRole) => {
      let max = 0;
      for (let t = 0; t <= 4000; t += 20) {
        max = Math.max(max, Math.abs(samplePose(gesture, t).rotate[role] ?? 0));
      }
      return max;
    };

    it('tchau levanta o braço direito bem alto', () => {
      expect(maxOver('wave', 'arm_right')).toBeGreaterThan(POSE_LIMITS.maxArmDeg * 0.5);
    });

    it('tchau mexe o braço que acena mais que o outro', () => {
      expect(maxOver('wave', 'arm_right')).toBeGreaterThan(maxOver('wave', 'arm_left'));
    });

    it('dançar move braços, pernas e tronco', () => {
      expect(maxOver('dance', 'arm_left')).toBeGreaterThan(5);
      expect(maxOver('dance', 'arm_right')).toBeGreaterThan(5);
      expect(maxOver('dance', 'leg_left')).toBeGreaterThan(2);
      expect(maxOver('dance', 'torso')).toBeGreaterThan(1);
    });

    it('dançar joga os braços para lados opostos', () => {
      const pose = samplePose('dance', 300);
      expect(Math.sign(pose.rotate.arm_left)).toBe(-Math.sign(pose.rotate.arm_right));
    });

    it('apontar SEGURA o braço em vez de oscilar', () => {
      const a = samplePose('point', 1500).rotate.arm_right;
      const b = samplePose('point', 3000).rotate.arm_right;
      expect(a).toBeCloseTo(b, 4);
      expect(Math.abs(a)).toBeGreaterThan(POSE_LIMITS.maxArmDeg * 0.5);
    });

    it('pular tira o mascote do chão e volta', () => {
      let min = 0;
      for (let t = 0; t <= 2000; t += 20) min = Math.min(min, samplePose('jump', t).offsetY);
      expect(min).toBeLessThan(-0.02);
      expect(samplePose('jump', 0).offsetY).toBeCloseTo(0, 3);
    });

    it('parado ainda respira — nunca fica congelado', () => {
      const scales = new Set<number>();
      for (let t = 0; t <= 3500; t += 100) scales.add(samplePose('idle', t).scale);
      expect(scales.size).toBeGreaterThan(5);
    });

    it('intensidade 0 zera o gesto mas mantém a respiração', () => {
      const pose = samplePose('dance', 600, 0);
      expect(pose.rotate.arm_left).toBe(0);
      expect(pose.offsetX).toBe(0);
      expect(pose.scale).not.toBe(1);
    });
  });

  describe('determinismo (preview no browser == vídeo no worker)', () => {
    it('mesma entrada, mesma pose', () => {
      for (const gesture of RIG_GESTURES) {
        for (const t of [0, 137, 1000, 4321]) {
          expect(samplePose(gesture, t)).toEqual(samplePose(gesture, t));
        }
      }
    });

    it('snapshot numérico dos frames de referência a 24 fps', () => {
      const frames = RIG_GESTURES.map((gesture) => ({
        gesture,
        poses: [0, 6, 12, 24, 48].map((f) =>
          samplePose(gesture, Math.round((f * 1000) / POSE_LIMITS.fps)),
        ),
      }));
      expect(frames).toMatchSnapshot();
    });
  });

  describe('resolvePose — aplica a pose às peças do rig', () => {
    it('devolve uma peça por camada visível, ordenada por z', () => {
      const resolved = resolvePose(rig(), samplePose('wave', 500));
      expect(resolved).toHaveLength(4);
      expect(resolved.map((r) => r.z)).toEqual([10, 20, 30, 40]);
    });

    it('cada peça recebe o ângulo da sua própria articulação', () => {
      const pose = samplePose('wave', 500);
      const resolved = resolvePose(rig(), pose);
      const arm = resolved.find((r) => r.layer.role === 'arm_right');
      expect(arm.rotateDeg).toBe(pose.rotate.arm_right);
      const torso = resolved.find((r) => r.layer.role === 'torso');
      expect(torso.rotateDeg).toBe(0); // tchau não gira o tronco
    });

    it('a origem da rotação vem do pivô da peça', () => {
      const resolved = resolvePose(rig(), samplePose('idle', 0));
      const head = resolved.find((r) => r.layer.role === 'head');
      expect(head.originXPct).toBe(50);
      expect(head.originYPct).toBe(97);
      const armRight = resolved.find((r) => r.layer.role === 'arm_right');
      expect(armRight.originXPct).toBe(15); // ombro do lado do tronco
    });

    it('peça invisível não é desenhada', () => {
      const r = rig();
      r.layers[0].visible = false;
      expect(resolvePose(r, samplePose('idle', 0))).toHaveLength(3);
    });

    it('não muda a posição base da peça — só a rotação', () => {
      const r = rig();
      const resolved = resolvePose(r, samplePose('dance', 400));
      const torso = resolved.find((x) => x.layer.role === 'torso');
      expect(torso.left).toBe(r.layers[1].rect.x);
      expect(torso.width).toBe(r.layers[1].rect.w);
    });
  });
});
