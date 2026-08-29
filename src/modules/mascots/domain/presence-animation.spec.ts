import {
  MASCOT_CRAFT,
  MASCOT_GESTURES,
  buildPresenceTimeline,
  isMascotEntrance,
  isMascotGesture,
  samplePresence,
  sampleTrack,
  toCssTransform,
} from './presence-animation';

describe('Animação de presença do mascote (spike §3.6)', () => {
  describe('parâmetros de craft', () => {
    it('respiração é ±1,5% em ciclo de 3,5 s', () => {
      expect(MASCOT_CRAFT.breathAmplitude).toBe(0.015);
      expect(MASCOT_CRAFT.breathCycleMs).toBe(3500);
    });

    it('rig roda a 24 fps e squash/stretch fica em no máximo 6%', () => {
      expect(MASCOT_CRAFT.fps).toBe(24);
      expect(MASCOT_CRAFT.maxSquashStretch).toBe(0.06);
    });

    it('há exatamente 5 presets de gesto (v1 congelada — risco 9)', () => {
      expect(MASCOT_GESTURES).toHaveLength(5);
    });
  });

  describe('respiração', () => {
    const timeline = buildPresenceTimeline({ durationMs: 7000, gesture: 'idle_bounce' });
    const scale = timeline.tracks.find((t) => t.property === 'scale');

    it('a escala existe e oscila dentro de ±1,5%', () => {
      expect(scale).toBeDefined();
      for (const kf of scale.keyframes) {
        expect(kf.value).toBeGreaterThanOrEqual(1 - MASCOT_CRAFT.breathAmplitude - 1e-9);
        expect(kf.value).toBeLessThanOrEqual(1 + MASCOT_CRAFT.breathAmplitude + 1e-9);
      }
    });

    it('atinge o pico em 1/4 de ciclo e o vale em 3/4', () => {
      expect(sampleTrack(scale, 875)).toBeCloseTo(1.015, 4);
      expect(sampleTrack(scale, 2625)).toBeCloseTo(0.985, 4);
      expect(sampleTrack(scale, 0)).toBeCloseTo(1, 4);
      expect(sampleTrack(scale, 3500)).toBeCloseTo(1, 4);
    });

    it('mantém o ciclo de 3,5 s ao longo de toda a timeline', () => {
      expect(sampleTrack(scale, 875 + 3500)).toBeCloseTo(sampleTrack(scale, 875), 4);
    });
  });

  describe('entrada lateral', () => {
    it('entra fora do quadro e chega a zero no fim da entrada', () => {
      const t = buildPresenceTimeline({ durationMs: 6000, entrance: 'left' });
      const tx = t.tracks.find((k) => k.property === 'translateX');
      expect(sampleTrack(tx, 0)).toBeCloseTo(-MASCOT_CRAFT.entranceOffset, 4);
      expect(sampleTrack(tx, MASCOT_CRAFT.entranceMs)).toBeCloseTo(0, 4);
      expect(sampleTrack(tx, 5000)).toBeCloseTo(0, 4);
    });

    it("entrance 'right' espelha o sinal", () => {
      const t = buildPresenceTimeline({ durationMs: 6000, entrance: 'right' });
      const tx = t.tracks.find((k) => k.property === 'translateX');
      expect(sampleTrack(tx, 0)).toBeCloseTo(MASCOT_CRAFT.entranceOffset, 4);
    });

    it('faz fade só no primeiro terço da entrada', () => {
      const t = buildPresenceTimeline({ durationMs: 6000, entrance: 'left' });
      const op = t.tracks.find((k) => k.property === 'opacity');
      expect(sampleTrack(op, 0)).toBe(0);
      expect(sampleTrack(op, MASCOT_CRAFT.entranceFadeMs)).toBeCloseTo(1, 4);
      expect(sampleTrack(op, 5000)).toBeCloseTo(1, 4);
    });

    it("entrance 'none' não gera trilha de opacidade nem deslocamento inicial", () => {
      const t = buildPresenceTimeline({
        durationMs: 6000,
        entrance: 'none',
        gesture: 'idle_bounce',
      });
      expect(t.tracks.find((k) => k.property === 'opacity')).toBeUndefined();
      expect(samplePresence(t, 0).translateX).toBe(0);
    });
  });

  describe('presets de gesto', () => {
    it.each(MASCOT_GESTURES)('%s produz timeline válida e limitada', (gesture) => {
      const t = buildPresenceTimeline({ durationMs: 5000, gesture });
      expect(t.version).toBe(1);
      expect(t.interpolation).toBe('linear');
      expect(t.gesture).toBe(gesture);
      for (let ms = 0; ms <= 5000; ms += 100) {
        const tr = samplePresence(t, ms);
        expect(Math.abs(tr.rotate)).toBeLessThanOrEqual(MASCOT_CRAFT.maxGestureRotationDeg + 1e-6);
        // escala combina respiração (1,5%) e squash/stretch (≤6%)
        expect(tr.scale).toBeLessThanOrEqual(
          (1 + MASCOT_CRAFT.breathAmplitude) * (1 + MASCOT_CRAFT.maxSquashStretch) + 1e-6,
        );
        expect(tr.scale).toBeGreaterThan(0.9);
        expect(Math.abs(tr.translateX)).toBeLessThanOrEqual(0.1);
        expect(Math.abs(tr.translateY)).toBeLessThanOrEqual(0.1);
      }
    });

    it('point desloca e inclina para o lado da oferta, e segura', () => {
      const t = buildPresenceTimeline({ durationMs: 5000, gesture: 'point' });
      expect(samplePresence(t, 1000).translateX).toBeCloseTo(0.04, 4);
      expect(samplePresence(t, 4000).translateX).toBeCloseTo(0.04, 4);
      expect(samplePresence(t, 1000).rotate).toBeCloseTo(4, 4);
    });

    it('intensity 0 anula o gesto mas mantém a respiração', () => {
      const t = buildPresenceTimeline({ durationMs: 5000, gesture: 'wave', intensity: 0 });
      expect(samplePresence(t, 600).rotate).toBe(0);
      expect(samplePresence(t, 875).scale).toBeCloseTo(1.015, 4);
    });
  });

  describe('determinismo (defesa contra divergência preview × export, §3.3)', () => {
    it('mesmas opções produzem exatamente os mesmos keyframes', () => {
      const a = buildPresenceTimeline({ durationMs: 4000, gesture: 'wave', entrance: 'left' });
      const b = buildPresenceTimeline({ durationMs: 4000, gesture: 'wave', entrance: 'left' });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('snapshot numérico dos frames de referência (a 24 fps)', () => {
      const t = buildPresenceTimeline({ durationMs: 4000, gesture: 'wave', entrance: 'left' });
      const frames = [0, 6, 12, 24, 48, 72, 96].map((frame) => {
        const tr = samplePresence(t, Math.round((frame * 1000) / MASCOT_CRAFT.fps));
        return [tr.translateX, tr.translateY, tr.scale, tr.rotate, tr.opacity];
      });
      expect(frames).toMatchSnapshot();
    });

    it('sampleTrack é interpolação linear pura, com clamp fora dos extremos', () => {
      const track = {
        property: 'scale' as const,
        keyframes: [
          { tMs: 0, value: 0 },
          { tMs: 100, value: 10 },
        ],
      };
      expect(sampleTrack(track, -50)).toBe(0);
      expect(sampleTrack(track, 25)).toBeCloseTo(2.5, 6);
      expect(sampleTrack(track, 50)).toBeCloseTo(5, 6);
      expect(sampleTrack(track, 500)).toBe(10);
    });
  });

  describe('idle em loop (§3.5)', () => {
    it('amostrar além da duração dá a volta — nunca congela no último frame', () => {
      const t = buildPresenceTimeline({ durationMs: 3000, gesture: 'idle_bounce' });
      expect(samplePresence(t, 3500)).toEqual(samplePresence(t, 500));
      expect(samplePresence(t, 9200)).toEqual(samplePresence(t, 200));
    });
  });

  describe('utilitários', () => {
    it('toCssTransform gera transform sem redesenhar nada', () => {
      const css = toCssTransform({
        translateX: 0.04,
        translateY: -0.01,
        scale: 1.015,
        rotate: 4,
        opacity: 1,
      });
      expect(css).toBe('translate(4%, -1%) scale(1.015) rotate(4deg)');
    });

    it('guards de gesto e entrada', () => {
      expect(isMascotGesture('wave')).toBe(true);
      expect(isMascotGesture('backflip')).toBe(false);
      expect(isMascotEntrance('left')).toBe(true);
      expect(isMascotEntrance('top')).toBe(false);
    });
  });
});
