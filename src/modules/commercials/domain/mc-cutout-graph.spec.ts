import {
  buildCutoutKeyChain,
  composeCutoutHashInput,
  cutoutDespillType,
  cutoutKeyHex,
  MC_CUTOUT_GRAPH_VERSION,
} from './mc-cutout-graph';
import { computeComposeFfmpegHash } from './mc-step-hashes';
import {
  buildClipWindowChain,
  buildComposeGraph,
  ComposeGraphInput,
  MC_COMPOSE_GRAPH_VERSION,
} from './mc-talking-art-graph';

const baseInput = (over: Partial<ComposeGraphInput> = {}): ComposeGraphInput => ({
  format: 'offer_piece',
  aspectRatio: '4:5',
  width: 1080,
  height: 1350,
  backgroundArtPath: '/uploads/still.png',
  artWidth: 1080,
  artHeight: 1350,
  window: { x: 0.05, y: 0.55, w: 0.4, h: 0.4 },
  logoFace: false,
  backgroundColor: '#112233',
  clips: [
    { sceneId: 'a', path: '/tmp/a.mp4', startS: 0, endS: 6 },
    { sceneId: 'b', path: '/tmp/b.mp4', startS: 6.2, endS: 13.2 },
  ],
  gapMs: 200,
  captionsEnabled: false,
  endcard: null,
  ...over,
});
const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('recorte por cor-chave no compose (video-mascote-transparente, D5)', () => {
  it('cadeia da chave: 4:4:4, chromakey, despill do tipo da chave, matte erodido e suavizado, alphamerge', () => {
    expect(buildCutoutKeyChain('1:v', '#00B140', '0', 'ck0')).toBe(
      '[1:v]format=yuv444p,chromakey=color=0x00B140:similarity=0.12:blend=0.05,' +
        'despill=type=green:mix=0.5:expand=0.1,split=2[k0][m0];' +
        '[m0]alphaextract,erosion,gblur=sigma=0.7[mm0];[k0][mm0]alphamerge[ck0]',
    );
    expect(cutoutKeyHex('#0047BB')).toBe('0x0047BB');
    expect(cutoutDespillType('#00B140')).toBe('green');
    expect(cutoutDespillType('#0047BB')).toBe('blue');
    expect(buildCutoutKeyChain('2:v', '#0047BB', '1', 'ck1')).toContain('despill=type=blue');
  });

  it('grafo sem fundo: snapshot — chave por clipe, encaixe inteiro colado embaixo com sobra transparente, sem fade nem head hold', () => {
    const plan = buildComposeGraph(
      baseInput({ cutout: { keyColor: '#00B140', framing: 'corpo' } }),
      '/tmp/work',
    );
    const graph = graphOf(plan.passes[0].args);
    expect(graph).toMatchSnapshot();
    expect(graph).toContain('chromakey=color=0x00B140');
    expect(graph).toContain('pad=432:540:(ow-iw)/2:oh-ih:color=black@0');
    expect(graph).toContain('scale=432:540:force_original_aspect_ratio=decrease');
    expect(graph).not.toContain('fade=');
    expect(graph).not.toContain('start_mode=clone');
    // o clipe entra de uma vez no seu instante e o anterior segura o último quadro no silêncio
    expect(graph).toContain("enable='between(t,6.2,13.2)'");
    expect(graph).toContain('stop_mode=clone:stop_duration=0.2');
  });

  it('arte que fala (F1): arte 1:1 contain-fit em 9:16 com a janela do tile de corpo; sem fundo remove a chave de cada clipe', () => {
    const plan = buildComposeGraph(
      baseInput({
        format: 'talking_art',
        aspectRatio: '9:16',
        width: 1080,
        height: 1920,
        artWidth: 1080,
        artHeight: 1080,
        window: { x: 0.55, y: 0.3, w: 0.4, h: 0.4219 },
        cutout: { keyColor: '#0047BB', framing: 'corpo' },
      }),
      '/tmp/work',
    );
    const graph = graphOf(plan.passes[0].args);
    expect(plan.artRect).toEqual({ x: 0, y: 420, width: 1080, height: 1080 });
    expect(graph).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x112233'); // a arte, como sempre
    expect(graph.match(/chromakey=color=0x0047BB/g)).toHaveLength(2);
    expect(graph).toContain('despill=type=blue');
    expect(plan.windowPx).toEqual({ x: 594, y: 576, width: 432, height: 810 });
  });

  it('Card, Círculo e rosto do logo ficam byte a byte como antes: sem chave, com pad da cor e com crossfade', () => {
    const card = graphOf(buildComposeGraph(baseInput(), '/tmp/w').passes[0].args);
    expect(card).not.toContain('chromakey');
    expect(card).toContain('pad=432:540:(ow-iw)/2:(oh-ih)/2:color=0x112233');
    expect(card).toContain('fade=t=in:st=6:d=0.2:alpha=1');
    const none = graphOf(buildComposeGraph(baseInput({ cutout: null }), '/tmp/w').passes[0].args);
    expect(none).toBe(card);
    const slot = {
      index: 0,
      durationS: 6,
      startS: 0,
      endS: 6,
      headHoldS: 0,
      tailHoldS: 0,
      fadeInS: 0,
    };
    expect(
      buildClipWindowChain(baseInput(), slot, { x: 0, y: 0, width: 100, height: 100 }),
    ).not.toContain('chromakey');
  });

  it('hash do compose: sem fundo entra no payload (chave, enquadramento, versões); sem ele o hash é o de antes', () => {
    const hashBase = {
      clips: [{ sceneId: 'a', finalAssetId: 'c1' }],
      backgroundArtAssetId: null,
      pieceHash: 'ph',
      aspectRatio: '4:5',
      window: { x: 0.05, y: 0.55, w: 0.4, h: 0.4 },
      logoFace: false,
      backgroundColor: '#112233',
      gapMs: 200,
      captionsEnabled: false,
      endcard: null,
      graphVersion: MC_COMPOSE_GRAPH_VERSION,
    };
    const plain = computeComposeFfmpegHash(hashBase);
    expect(computeComposeFfmpegHash({ ...hashBase, cutout: null })).toBe(plain);
    const cutout = composeCutoutHashInput({ keyColor: '#00B140', framing: 'corpo' });
    expect(cutout).toMatchObject({
      similarity: 0.12,
      blend: 0.05,
      graphVersion: MC_CUTOUT_GRAPH_VERSION,
    });
    const withCutout = computeComposeFfmpegHash({ ...hashBase, cutout });
    expect(withCutout).not.toBe(plain);
    expect(
      computeComposeFfmpegHash({
        ...hashBase,
        cutout: composeCutoutHashInput({ keyColor: '#0047BB', framing: 'corpo' }),
      }),
    ).not.toBe(withCutout);
    expect(MC_COMPOSE_GRAPH_VERSION).toBe(2); // sem bump: nenhum hash existente muda
  });
});
