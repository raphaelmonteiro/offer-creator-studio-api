import {
  FfmpegGraphBuilder,
  GRAPH_LIMITS,
  RenderSpec,
  RenderSpecError,
} from './ffmpeg-graph-builder';

const builder = new FfmpegGraphBuilder();

const baseSpec = (overrides: Partial<RenderSpec> = {}): RenderSpec => ({
  format: 'mp4',
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 5000,
  quality: 'standard',
  layers: [
    { type: 'video', filePath: '/up/bg.mp4', x: 0, y: 0, w: 1, h: 1, loop: true, zIndex: 0 },
    { type: 'image_overlay', filePath: '/up/overlay.png', x: 0, y: 0, w: 1, h: 1, zIndex: 10 },
  ],
  ...overrides,
});

describe('FfmpegGraphBuilder (TDD §6.1)', () => {
  it('mp4: 1 passo, h264 veryfast, faststart, filtro com overlay', () => {
    const { passes } = builder.build(baseSpec(), '/out/final.mp4');
    expect(passes).toHaveLength(1);
    const cmd = passes[0].join(' ');
    expect(cmd).toContain('-c:v libx264');
    expect(cmd).toContain('-preset veryfast');
    expect(cmd).toContain('+faststart');
    expect(cmd).toContain('overlay=');
    expect(cmd).toContain('scale=1080:1920');
    expect(passes[0][passes[0].length - 1]).toBe('/out/final.mp4');
  });

  it('multi-mascote: cada mascote ganha janela enable=between própria', () => {
    const spec = baseSpec();
    spec.layers.push(
      {
        type: 'mascot',
        filePath: '/up/m1.webm',
        x: 0.7,
        y: 0.6,
        w: 0.25,
        h: 0.3,
        startMs: 0,
        endMs: 5000,
        loop: true,
        zIndex: 40,
        hasAlpha: true,
      },
      {
        type: 'mascot',
        filePath: '/up/m2.webm',
        x: 0.1,
        y: 0.6,
        w: 0.25,
        h: 0.3,
        startMs: 3000,
        endMs: 5000,
        loop: true,
        zIndex: 50,
        hasAlpha: true,
      },
    );
    const filter = builder.build(spec, '/out/f.mp4').passes[0].join(' ');
    expect(filter).toContain("enable='between(t,0,5)'");
    expect(filter).toContain("enable='between(t,3,5)'");
    // sem chromakey — alpha nativo do mezanino (TDD §5.2)
    expect(filter).not.toContain('chromakey');
  });

  it('múltiplos áudios: adelay por camada + amix + afade', () => {
    const spec = baseSpec();
    spec.layers.push(
      { type: 'audio', filePath: '/up/voice.mp3', startMs: 500, volume: 1, x: 0, y: 0, w: 1, h: 1 },
      { type: 'audio', filePath: '/up/music.mp3', startMs: 0, volume: 0.3, x: 0, y: 0, w: 1, h: 1 },
    );
    const cmd = builder.build(spec, '/out/f.mp4').passes[0].join(' ');
    expect(cmd).toContain('adelay=500|500');
    expect(cmd).toContain('volume=0.3');
    expect(cmd).toContain('amix=inputs=2:duration=longest:normalize=0');
    expect(cmd).toContain('afade=t=out');
    expect(cmd).toContain('-c:a aac');
  });

  it('gif: 2 passos (palettegen/paletteuse), sem áudio, fps 12 e largura ≤480', () => {
    const spec = baseSpec({ format: 'gif' });
    spec.layers.push({ type: 'audio', filePath: '/up/a.mp3', x: 0, y: 0, w: 1, h: 1, startMs: 0 });
    const { passes } = builder.build(spec, '/out/f.gif');
    expect(passes).toHaveLength(2);
    expect(passes[0].join(' ')).toContain('palettegen=stats_mode=diff');
    expect(passes[1].join(' ')).toContain('paletteuse=dither=bayer:bayer_scale=4');
    expect(passes[1].join(' ')).toContain(`fps=${GRAPH_LIMITS.gifFps}`);
    expect(passes[1].join(' ')).toContain(`scale=${GRAPH_LIMITS.gifMaxWidth}:-2`);
    for (const pass of passes) {
      expect(pass.join(' ')).not.toContain('a.mp3'); // áudio descartado em GIF
    }
  });

  it('webm: vp9 + opus', () => {
    const spec = baseSpec({ format: 'webm' });
    spec.layers.push({ type: 'audio', filePath: '/up/a.mp3', x: 0, y: 0, w: 1, h: 1, startMs: 0 });
    const cmd = builder.build(spec, '/out/f.webm').passes[0].join(' ');
    expect(cmd).toContain('-c:v libvpx-vp9');
    expect(cmd).toContain('-c:a libopus');
  });

  it('sem áudio: -an', () => {
    const cmd = builder.build(baseSpec(), '/out/f.mp4').passes[0].join(' ');
    expect(cmd).toContain('-an');
  });

  it('rejeita mais de 4 camadas de vídeo', () => {
    const spec = baseSpec();
    for (let i = 0; i < 4; i++) {
      spec.layers.push({
        type: 'mascot',
        filePath: `/up/m${i}.webm`,
        x: 0,
        y: 0,
        w: 0.2,
        h: 0.2,
        zIndex: i + 20,
      });
    }
    expect(() => builder.build(spec, '/out/f.mp4')).toThrow(RenderSpecError);
  });

  it('sem camadas visuais e sem cor de fundo é rejeitado', () => {
    const spec = baseSpec({
      layers: [{ type: 'audio', filePath: '/up/a.mp3', x: 0, y: 0, w: 1, h: 1, startMs: 0 }],
    });
    expect(() => builder.build(spec, '/out/f.mp4')).toThrow(RenderSpecError);
  });

  it('snapshot do comando mp4 mínimo (regressão de sintaxe)', () => {
    const { passes } = builder.build(baseSpec(), '/out/final.mp4', '/tmp/x');
    expect(passes[0]).toMatchSnapshot();
  });

  it('é determinístico: mesmo spec → mesmo comando', () => {
    const a = builder.build(baseSpec(), '/out/f.mp4', '/tmp/x');
    const b = builder.build(baseSpec(), '/out/f.mp4', '/tmp/x');
    expect(a).toEqual(b);
  });
});
