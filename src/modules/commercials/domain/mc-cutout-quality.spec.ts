import { buildCutoutIssue } from './mc-cutout-issue';
import {
  cutoutSampleFrameIndexes,
  evaluateCutoutClip,
  McCutoutFrame,
  measureCutoutFrame,
} from './mc-cutout-quality';

const W = 120;
const H = 160;
const KEY: [number, number, number] = [0x00, 0xb1, 0x40];
const FIG: [number, number, number] = [0xe0, 0x60, 0x2a];

interface FrameOptions {
  background?: [number, number, number];
  /** Cor do anel de 2 px dentro da silhueta (halo). */
  ring?: [number, number, number];
  /** Bloco da cor de fundo DENTRO da personagem (resto da chave). */
  hole?: boolean;
  figure?: { x: number; y: number; w: number; h: number };
}

/** Quadro sintético: fundo liso, uma silhueta retangular opaca no alfa. */
function frame(opts: FrameOptions = {}): McCutoutFrame {
  const bg = opts.background ?? KEY;
  const fig = opts.figure ?? { x: 40, y: 30, w: 40, h: 100 };
  const rgb = new Uint8Array(W * H * 3);
  const alpha = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const inside = x >= fig.x && x < fig.x + fig.w && y >= fig.y && y < fig.y + fig.h;
      let color = bg;
      if (inside) {
        alpha[i] = 255;
        color = FIG;
        const edge = Math.min(x - fig.x, fig.x + fig.w - 1 - x, y - fig.y, fig.y + fig.h - 1 - y);
        if (opts.ring && edge < 2) color = opts.ring;
        if (opts.hole && x >= fig.x + 15 && x < fig.x + 25 && y >= fig.y + 40 && y < fig.y + 50) {
          color = bg;
        }
      }
      rgb.set(color, i * 3);
    }
  }
  return { rgb, alpha, width: W, height: H };
}

const metrics = (frames: McCutoutFrame[]) => frames.map((f) => measureCutoutFrame(f, '#00B140'));

describe('verificação do recorte (D7)', () => {
  it('clipe estável: fundo na cor-chave, sem resto nem halo → aprova', () => {
    const verdict = evaluateCutoutClip(metrics(Array.from({ length: 8 }, () => frame())));
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.metrics.matteCoverage).toBeGreaterThan(0.1);
    expect(verdict.metrics.backgroundOffsetDeltaE).toBeLessThan(1);
    expect(verdict.metrics.backgroundDrift).toBe(0);
  });

  it('fundo que muda de tom no meio do clipe (fixture instável) → reprova por background_unstable (deriva)', () => {
    const frames = Array.from({ length: 8 }, (_, i) =>
      frame({ background: i < 4 ? KEY : [0x20, 0xc8, 0x70] }),
    );
    const verdict = evaluateCutoutClip(metrics(frames));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain('background_unstable');
    expect(verdict.metrics.backgroundDrift).toBeGreaterThan(5);
  });

  it('fundo de outra cor que não a chave → background_not_key', () => {
    const verdict = evaluateCutoutClip(metrics([frame({ background: [0x80, 0x80, 0x80] })]));
    expect(verdict.reasons).toContain('background_not_key');
  });

  it('cor de fundo dentro da personagem → key_residue; halo verde na borda → edge_fringe', () => {
    expect(evaluateCutoutClip(metrics([frame({ hole: true })])).reasons).toContain('key_residue');
    const halo = evaluateCutoutClip(metrics([frame({ ring: [0x30, 0xd0, 0x50] })]));
    expect(halo.reasons).toContain('edge_fringe');
    expect(halo.metrics.fringeExcess).toBeGreaterThan(0.04);
  });

  it('chave azul: contorno escuro da personagem NÃO é halo; reflexo azul na borda é (só o excesso positivo conta)', () => {
    const BLUE: [number, number, number] = [0x00, 0x47, 0xbb];
    const blue = (f: McCutoutFrame) => measureCutoutFrame(f, '#0047BB');
    const outlined = blue(frame({ background: BLUE, ring: [0x70, 0x40, 0x20] }));
    expect(outlined.fringeExcess).toBeLessThanOrEqual(0.001);
    expect(evaluateCutoutClip([outlined]).passed).toBe(true);
    const haloed = blue(frame({ background: BLUE, ring: [0x40, 0x60, 0xd0] }));
    expect(haloed.fringeExcess).toBeGreaterThan(0.04);
    expect(evaluateCutoutClip([haloed]).reasons).toContain('edge_fringe');
  });

  it('matte vazio ou cheio → matte_empty / matte_full', () => {
    const empty = frame({ figure: { x: 0, y: 0, w: 2, h: 2 } });
    expect(evaluateCutoutClip(metrics([empty])).reasons).toContain('matte_empty');
    const full = frame({ figure: { x: 0, y: 0, w: W, h: H - 4 } });
    expect(evaluateCutoutClip(metrics([full])).reasons).toContain('matte_full');
  });

  it('qualquer quadro fora do limite reprova o clipe inteiro', () => {
    const frames = Array.from({ length: 8 }, () => frame());
    frames[5] = frame({ hole: true });
    expect(evaluateCutoutClip(metrics(frames)).passed).toBe(false);
  });

  it('instantes (i + 0,5) / 8 × duração a 30 fps, sem repetir quadro', () => {
    expect(cutoutSampleFrameIndexes(8)).toEqual([15, 45, 75, 105, 135, 165, 195, 225]);
    expect(cutoutSampleFrameIndexes(0.1)).toEqual([0, 1, 2]);
  });

  it('cutoutIssue: motivos em pt-BR por cena, chave e ações espelhadas', () => {
    const issue = buildCutoutIssue(
      {
        keyColor: '#00B140',
        framing: 'corpo',
        scenes: [
          {
            sceneId: 's1',
            idx: 1,
            reasons: ['background_unstable', 'edge_fringe'],
            metrics: { backgroundDrift: 6.4 },
          },
          { sceneId: 's2', idx: 2, reasons: ['inventado'], metrics: {} },
        ],
      },
      ['gerar_fala_de_novo', 'usar_painel_liso'],
    );
    expect(issue.code).toBe('character_cutout_failed');
    expect(issue.message).toContain('2 fala(s)');
    expect(issue.keyColor).toBe('#00B140');
    expect(issue.scenes[0].reasons).toEqual([
      { code: 'background_unstable', message: 'O fundo mudou de tom durante a fala.' },
      { code: 'edge_fringe', message: expect.stringContaining('halo') },
    ]);
    expect(issue.scenes[1].reasons).toEqual([]); // motivo desconhecido não vaza
    expect(issue.actions).toEqual(['gerar_fala_de_novo', 'usar_painel_liso']);
    expect(buildCutoutIssue(null, []).scenes).toEqual([]);
  });
});
