import {
  buildComposeGraph,
  ComposeGraphInput,
  composeTimeline,
  continuousClipTimes,
  sliceSpeechMs,
} from './mc-talking-art-graph';
import { MC_TALK_GAP_MS } from './mc-talk-conform-graph';

/**
 * Grafo do compose em fala contínua (change video-fala-continua, 1.6, D9): as fatias dos trechos se
 * encostam — sem último quadro seguro, sem entrada atrasada e sem fade em nenhuma fronteira — em
 * todos os modos de painel (Card/Círculo, sem fundo e rosto do logo).
 */
const speech = [
  { sceneId: 'a', durationMs: 2168 },
  { sceneId: 'b', durationMs: 1907 },
  { sceneId: 'c', durationMs: 4310 },
];
const timeline = composeTimeline(speech, MC_TALK_GAP_MS);

const input = (over: Partial<ComposeGraphInput> = {}): ComposeGraphInput => ({
  format: 'offer_piece',
  aspectRatio: '4:5',
  width: 1080,
  height: 1350,
  backgroundArtPath: '/uploads/still.png',
  artWidth: 1080,
  artHeight: 1350,
  window: { x: 0.5, y: 0.5, w: 0.4, h: 0.3 },
  logoFace: false,
  backgroundColor: '#FFFFFF',
  clips: continuousClipTimes(timeline.clips).map((c) => ({ ...c, path: `/tmp/${c.sceneId}.mp4` })),
  gapMs: MC_TALK_GAP_MS,
  captionsEnabled: true,
  endcard: null,
  continuous: { version: 1 },
  ...over,
});

const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];
const args = (over: Partial<ComposeGraphInput> = {}) =>
  buildComposeGraph(input(over), '/tmp/work').passes[0].args;

describe('continuousClipTimes — fatias encostadas (D9)', () => {
  it('o fim de cada fatia é o início da fala seguinte; a última termina onde a fala termina', () => {
    expect(continuousClipTimes(timeline.clips)).toEqual([
      { sceneId: 'a', startS: 0, endS: 2.368 },
      { sceneId: 'b', startS: 2.368, endS: 4.475 },
      { sceneId: 'c', startS: 4.475, endS: 8.785 },
    ]);
  });

  it('a duração da fala da fatia vem do metadata do ingest; sem ele vale a do arquivo', () => {
    expect(sliceSpeechMs({ speechMs: 2168 }, 2368)).toBe(2168);
    expect(sliceSpeechMs({}, 4310)).toBe(4310);
    expect(sliceSpeechMs(null, 4310)).toBe(4310);
    expect(sliceSpeechMs({ speechMs: 0 }, 4310)).toBe(4310);
  });
});

describe('buildComposeGraph em modo contínuo', () => {
  it('Card/Círculo: nenhuma segura de quadro, nenhuma entrada atrasada, nenhum fade; fronteiras exclusivas', () => {
    const graph = graphOf(args());
    expect(graph).not.toMatch(/start_mode=clone/);
    expect(graph).not.toMatch(/stop_duration=(?!0\.1\b)/); // só o clone de 100 ms contra o arredondamento
    expect(graph).not.toContain('fade=');
    expect(graph).toContain("enable='gte(t,0)*lt(t,2.368)'");
    expect(graph).toContain("enable='gte(t,2.368)*lt(t,4.475)'");
    expect(graph).toContain("enable='between(t,4.475,8.785)'"); // a última fatia fecha o vídeo
    expect(graph).toContain('setpts=PTS-STARTPTS+2.368/TB');
    // a fatia ganha um quadro inteiro a mais antes do trim (o trim só guarda quadros inteiros: sem isso cai um quadro na fronteira)
    expect(graph).toContain('trim=duration=2.401'); // 2,368 s + 1/30 s
  });

  it('o áudio é cada TTS no instante da fala (adelay) com a duração da fatia; legendas e áudio nos mesmos instantes de hoje', () => {
    const graph = graphOf(args());
    expect(graph).toContain('atrim=duration=2.368');
    expect(graph).toContain('adelay=delays=113664S:all=1'); // 2,368 s × 48 kHz
    expect(graph).toContain('adelay=delays=214800S:all=1'); // 4,475 s
    const today = buildComposeGraph(
      input({
        continuous: null,
        clips: timeline.clips.map((c) => ({ ...c, path: `/tmp/${c.sceneId}.mp4` })),
      }),
      '/tmp/work',
    );
    const todayGraph = graphOf(today.passes[0].args);
    expect(todayGraph).toContain('adelay=delays=113664S:all=1');
    expect(todayGraph).toContain('adelay=delays=214800S:all=1');
    // duração total e instantes de início = os do modo de hoje
    expect(today.expectedDurationMs).toBe(8785);
    expect(buildComposeGraph(input(), '/tmp/work').expectedDurationMs).toBe(8785);
  });

  it('o modo de hoje continua com seguras e fade (flag desligada não muda o grafo)', () => {
    const today = buildComposeGraph(
      input({
        continuous: null,
        clips: timeline.clips.map((c) => ({ ...c, path: `/tmp/${c.sceneId}.mp4` })),
      }),
      '/tmp/work',
    ).passes[0].args;
    expect(graphOf(today)).toContain('fade=t=in');
    expect(graphOf(today)).toMatch(/stop_mode=clone:stop_duration=0\.2/);
  });

  it('sem fundo: o recorte segue por fatia, sem crossfade (snapshot)', () => {
    const cutout = args({
      cutout: { keyColor: '#00B140', framing: 'corpo' },
      backgroundColor: '#00B140',
    });
    expect(graphOf(cutout)).toContain('chromakey');
    expect(graphOf(cutout)).not.toContain('fade=');
    expect(cutout).toMatchSnapshot();
  });

  it('rosto do logo: ajuste por largura e fronteiras exclusivas (snapshot)', () => {
    const logo = args({
      format: 'talking_art',
      logoFace: true,
      logoBox: { x: 0.1, y: 0.05, w: 0.3, h: 0.2 },
    });
    expect(graphOf(logo)).toContain("enable='gte(t,0)*lt(t,2.368)'");
    expect(graphOf(logo)).not.toContain('fade=');
    expect(logo).toMatchSnapshot();
  });

  it('Card (snapshot do passe inteiro)', () => {
    expect(args()).toMatchSnapshot();
  });
});
