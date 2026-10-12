import { computeComposeFfmpegHash } from './mc-step-hashes';
import { MC_TALK_GAP_MS } from './mc-talk-conform-graph';
import {
  buildComposeGraph,
  ComposeGraphInput,
  composedOutputIssue,
  composeHashWindow,
  composeTimeline,
  ffmpegColor,
  MC_COMPOSE_GRAPH_VERSION,
  resolveWindowPx,
} from './mc-talking-art-graph';
import { windowToPixels } from './mc-talking-art-window';

const baseInput = (over: Partial<ComposeGraphInput> = {}): ComposeGraphInput => ({
  format: 'talking_art',
  aspectRatio: '9:16',
  width: 1080,
  height: 1920,
  backgroundArtPath: '/uploads/art.png',
  artWidth: 1080,
  artHeight: 1350,
  window: { x: 0.5398, y: 0.4357, w: 0.4, h: 0.2143 },
  logoFace: false,
  backgroundColor: '#112233',
  clips: [
    { sceneId: 'a', path: '/tmp/a.mp4', startS: 0, endS: 6 },
    { sceneId: 'b', path: '/tmp/b.mp4', startS: 6.2, endS: 13.2 },
    { sceneId: 'c', path: '/tmp/c.mp4', startS: 13.4, endS: 18.4 },
  ],
  gapMs: MC_TALK_GAP_MS,
  captionsEnabled: true,
  endcard: null,
  ...over,
});

const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('mc-talking-art-graph — composição do F1 (tarefa 4.4)', () => {
  it('composeTimeline: instantes = soma das durações medidas + silêncios (D7)', () => {
    const t = composeTimeline(
      [
        { sceneId: 'a', durationMs: 6000 },
        { sceneId: 'b', durationMs: 7000 },
        { sceneId: 'c', durationMs: 5000 },
      ],
      200,
    );
    expect(t.clips).toEqual([
      { sceneId: 'a', startS: 0, endS: 6 },
      { sceneId: 'b', startS: 6.2, endS: 13.2 },
      { sceneId: 'c', startS: 13.4, endS: 18.4 },
    ]);
    expect(t.totalS).toBe(18.4);
  });

  it('passe único: arte em loop pela duração das falas, contain-fit com pad da cor (nunca crop da arte), janela com overlay enable=between, TTS com adelay + amix normalize=0; nunca -shortest', () => {
    const plan = buildComposeGraph(baseInput(), '/tmp/work');
    expect(MC_COMPOSE_GRAPH_VERSION).toBe(2);
    expect(plan.passes.map((p) => p.label)).toEqual(['compose']);
    expect(plan.output).toBe('/tmp/work/composed.mp4');
    expect(plan.expectedDurationMs).toBe(18_400);
    const args = plan.passes[0].args;
    // base: imagem parada em loop com -t = duração falada
    expect(args.slice(0, 14)).toEqual([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '18.4',
      '-i',
      '/uploads/art.png',
      '-i',
      '/tmp/a.mp4',
    ]);
    expect(args).toContain('anullsrc=r=48000:cl=stereo');
    expect(args.join(' ')).not.toContain('-shortest');
    const graph = graphOf(args);
    expect(graph).toContain(
      '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,' +
        'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x112233,setsar=1,fps=30,format=yuv420p[base]',
    );
    expect(graph).not.toMatch(/\[0:v\][^;]*crop/); // a arte nunca é recortada
    // janela: 432×412 em (583, 837) — encaixe contain-fit + pad da cor
    const win = windowToPixels(baseInput().window, 1080, 1920);
    expect(win).toEqual({ x: 583, y: 837, width: 432, height: 412 });
    expect(graph).toContain(
      'scale=432:412:force_original_aspect_ratio=decrease,pad=432:412:(ow-iw)/2:(oh-ih)/2:color=0x112233',
    );
    expect(graph).toContain(
      "[base][c0]overlay=x=583:y=837:eof_action=pass:enable='between(t,0,6.2)'[v0]",
    );
    expect(graph).toContain(
      "[v0][c1]overlay=x=583:y=837:eof_action=pass:enable='between(t,6,13.4)'[v1]",
    );
    expect(graph).toContain(
      "[v1][c2]overlay=x=583:y=837:eof_action=pass:enable='between(t,13.2,18.4)'[vwin]",
    );
    // crossfade ≤ 200 ms DENTRO do silêncio: a fala anterior segura o último
    // quadro, a seguinte entra com fade de alfa a partir do fim da anterior
    expect(graph).toContain('tpad=stop_mode=clone:stop_duration=0.2,setpts=PTS-STARTPTS+0/TB[c0]');
    expect(graph).toContain(
      'tpad=start_mode=clone:start_duration=0.2:stop_mode=clone:stop_duration=0.2,' +
        'setpts=PTS-STARTPTS+6/TB,fade=t=in:st=6:d=0.2:alpha=1[c1]',
    );
    expect(graph).toContain(
      'tpad=start_mode=clone:start_duration=0.2,setpts=PTS-STARTPTS+13.2/TB,' +
        'fade=t=in:st=13.2:d=0.2:alpha=1[c2]',
    );
    // áudio: TTS de cada clipe atrasado (em amostras) e misturado sobre silêncio
    expect(graph).toContain('adelay=delays=0S:all=1[s0]');
    expect(graph).toContain('adelay=delays=297600S:all=1[s1]');
    expect(graph).toContain('adelay=delays=643200S:all=1[s2]');
    expect(graph).toContain(
      '[4:a][s0][s1][s2]amix=inputs=4:duration=first:dropout_transition=0:normalize=0',
    );
    expect(args).toMatchSnapshot();
  });

  it('cartela opcional: compose + buildEndcardArgs + concat; duração esperada = falas + silêncios + 2 s', () => {
    const plan = buildComposeGraph(
      baseInput({ endcard: { storeName: 'Mercado do Zé' } }),
      '/tmp/w',
    );
    expect(plan.passes.map((p) => p.label)).toEqual(['compose', 'endcard', 'concat']);
    expect(plan.passes[0].output).toBe('/tmp/w/speech.mp4');
    expect(plan.concatInputs).toEqual(['/tmp/w/speech.mp4', '/tmp/w/endcard.mp4']);
    expect(plan.expectedDurationMs).toBe(20_400);
    expect(plan.passes[1].args.join(' ')).toContain('Mercado do Zé');
    expect(plan.passes[1].args.join(' ')).toContain('color=c=0x1F2430:s=1080x1920');
    expect(plan.passes[2].args).toEqual(
      expect.arrayContaining(['-f', 'concat', '/tmp/w/concat.txt', '/tmp/w/composed.mp4']),
    );
    expect(() => buildComposeGraph(baseInput({ clips: [] }), '/tmp/w')).toThrow(/nenhum clipe/);
  });

  it('preenchimento desfocado: split/boxblur/overlay com a arte inteira contain-fit por cima', () => {
    const plan = buildComposeGraph(baseInput({ fill: 'blur' }), '/tmp/w');
    const graph = graphOf(plan.passes[0].args);
    expect(graph).toContain(
      '[0:v]split=2[artbg][artfg];' +
        '[artbg]scale=136:240:force_original_aspect_ratio=increase,crop=136:240,boxblur=6:2,' +
        'scale=1080:1920,setsar=1[blurbg];' +
        '[artfg]scale=1080:1920:force_original_aspect_ratio=decrease[artfit];' +
        '[blurbg][artfit]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[base]',
    );
    expect(graph).not.toContain('pad=1080:1920');
    expect(plan.passes[0].args).toMatchSnapshot();
  });

  it('sem arte: base lisa da cor (lavfi) — o processor recusa antes quando a arte some', () => {
    const plan = buildComposeGraph(baseInput({ backgroundArtPath: null }), '/tmp/w');
    const args = plan.passes[0].args;
    expect(args).toContain('color=c=0x112233:s=1080x1920:r=30:d=18.4');
    expect(graphOf(args).startsWith('[0:v]setsar=1,fps=30,format=yuv420p[base]')).toBe(true);
    expect(plan.artRect).toBeNull();
  });

  it('modo rosto do logo: janela = caixa do projeto (frações da ARTE) pelo contain-fit; clipe ajustado por LARGURA, excedente vertical na cor', () => {
    const input = baseInput({
      logoFace: true,
      logoBox: { x: 0.1, y: 0.05, w: 0.3, h: 0.1 },
      backgroundColor: '#C8102E',
    });
    // arte 1080×1350 em 1080×1920: desce 285 px (faixa superior)
    expect(resolveWindowPx(input)).toEqual({ x: 108, y: 353, width: 324, height: 136 });
    const plan = buildComposeGraph(input, '/tmp/w');
    expect(plan.windowPx).toEqual({ x: 108, y: 353, width: 324, height: 136 });
    expect(plan.artRect).toEqual({ x: 0, y: 285, width: 1080, height: 1350 });
    const graph = graphOf(plan.passes[0].args);
    expect(graph).toContain(
      "scale=324:-2,crop=iw:'min(ih,136)',pad=324:136:(ow-iw)/2:(oh-ih)/2:color=0xC8102E",
    );
    expect(graph).toContain("overlay=x=108:y=353:eof_action=pass:enable='between(t,0,6.2)'");
    // a janela do roteiro é ignorada no modo rosto do logo
    expect(graph).not.toContain('overlay=x=583');
    expect(plan.passes[0].args).toMatchSnapshot();
  });

  it('composeHashWindow: janela resolvida (rosto do logo = caixa mapeada) — mover a caixa muda o hash do compose', () => {
    const common = {
      window: { x: 0.5398, y: 0.4357, w: 0.4, h: 0.2143 },
      artWidth: 1080,
      artHeight: 1350,
      width: 1080,
      height: 1920,
    };
    expect(composeHashWindow({ ...common, logoFace: false, logoBox: null })).toEqual(common.window);
    const logo = composeHashWindow({
      ...common,
      logoFace: true,
      logoBox: { x: 0.1, y: 0.05, w: 0.3, h: 0.1 },
    });
    expect(logo).toEqual({ x: 0.1, y: 0.1839, w: 0.3, h: 0.0708 });
    const moved = composeHashWindow({
      ...common,
      logoFace: true,
      logoBox: { x: 0.12, y: 0.05, w: 0.3, h: 0.1 },
    });
    const hashOf = (window: typeof logo) =>
      computeComposeFfmpegHash({
        clips: [{ sceneId: 'a', finalAssetId: 'f1' }],
        backgroundArtAssetId: 'art',
        aspectRatio: '9:16',
        window,
        logoFace: true,
        backgroundColor: '#C8102E',
        gapMs: 200,
        captionsEnabled: true,
        endcard: null,
        graphVersion: MC_COMPOSE_GRAPH_VERSION,
      });
    expect(hashOf(moved)).not.toBe(hashOf(logo));
    expect(hashOf(logo)).toBe(hashOf({ ...logo! }));
  });

  it('aspectos: 1:1 → 1080×1080 sem faixas; 1:1 → 9:16 com faixas acima/abaixo; 1280×928 → 1920×1080 com faixas laterais', () => {
    const square = buildComposeGraph(
      baseInput({ width: 1080, height: 1080, aspectRatio: '1:1', artWidth: 1080, artHeight: 1080 }),
      '/w',
    );
    expect(square.artRect).toEqual({ x: 0, y: 0, width: 1080, height: 1080 });
    const reels = buildComposeGraph(baseInput({ artWidth: 1080, artHeight: 1080 }), '/w');
    expect(reels.artRect).toEqual({ x: 0, y: 420, width: 1080, height: 1080 });
    const nini = buildComposeGraph(
      baseInput({
        width: 1920,
        height: 1080,
        aspectRatio: '16:9',
        artWidth: 1280,
        artHeight: 928,
        window: { x: 0.8, y: 0.5, w: 0.15, h: 0.45 },
      }),
      '/w',
    );
    expect(nini.artRect).toEqual({ x: 215, y: 0, width: 1490, height: 1080 });
    expect(graphOf(nini.passes[0].args)).toContain(
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
    );
  });

  it('composedOutputIssue: vídeo + áudio, dimensões de saída e duração dentro da tolerância', () => {
    const ok = { hasVideo: true, hasAudio: true, durationMs: 18_450, width: 1080, height: 1920 };
    const expected = { durationMs: 18_400, width: 1080, height: 1920 };
    expect(composedOutputIssue(ok, expected)).toBeNull();
    expect(composedOutputIssue({ ...ok, hasAudio: false }, expected)).toBe(
      'composed_without_audio',
    );
    expect(composedOutputIssue({ ...ok, width: 720 }, expected)).toBe(
      'composed_dimensions_mismatch',
    );
    expect(composedOutputIssue({ ...ok, durationMs: 19_000 }, expected)).toBe(
      'composed_duration_mismatch',
    );
    expect(ffmpegColor('xyz')).toBe('0xFFFFFF');
    expect(ffmpegColor('#aabbccdd')).toBe('0xAABBCC');
  });

  it('hash do compose muda com clipes, arte, janela, cor, silêncio, legendas, cartela e versão do grafo', () => {
    const base = {
      clips: [{ sceneId: 'a', finalAssetId: 'f1' }],
      backgroundArtAssetId: 'art',
      aspectRatio: '9:16',
      window: { x: 0.5, y: 0.4, w: 0.4, h: 0.2 },
      logoFace: false,
      backgroundColor: '#112233',
      gapMs: 200,
      captionsEnabled: true,
      endcard: null,
      graphVersion: MC_COMPOSE_GRAPH_VERSION,
    };
    const h = computeComposeFfmpegHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeComposeFfmpegHash({ ...base, backgroundColor: '#112233' })).toBe(h);
    expect(computeComposeFfmpegHash({ ...base, backgroundColor: '#112234' })).not.toBe(h);
    expect(computeComposeFfmpegHash({ ...base, window: { ...base.window, x: 0.1 } })).not.toBe(h);
    expect(
      computeComposeFfmpegHash({ ...base, clips: [{ sceneId: 'a', finalAssetId: 'f2' }] }),
    ).not.toBe(h);
    expect(computeComposeFfmpegHash({ ...base, graphVersion: 1 })).not.toBe(h);
    expect(computeComposeFfmpegHash({ ...base, endcard: 'Loja' })).not.toBe(h);
  });
});
