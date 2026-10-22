import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import {
  FFMPEG_FIXTURES_ENABLED,
  inset,
  lumaAt,
  meanRgbAt,
  probe,
  psnrMasked,
  Rect,
  referenceLuma,
  runComposePlan,
  tinyClip,
} from './__fixtures__/mc-ffmpeg-fixture.helpers';
import { fixturePieceDocument } from './__fixtures__/mc-piece.fixtures';
import { buildOfferPieceStillProps, pieceRectToPx } from './mc-piece-still-props';
import {
  buildArtBaseChain,
  buildComposeGraph,
  ComposeGraphInput,
  composedOutputIssue,
  composeTimeline,
} from './mc-talking-art-graph';
import { MockStillRenderer } from '../services/mc-still-renderer';

/**
 * Fixture com FFmpeg REAL do compose da PEÇA DE OFERTAS (change
 * video-peca-configuravel, 6.4/6.8): o quadro parado do renderizador mock
 * (sharp, 1080×1920) entra como arte — já no tamanho de saída, sem pad nem
 * ajuste — e o personagem (clipe minúsculo) ocupa o rect do bloco. Mede o PSNR
 * de luma da região do quadro fora da janela (fidelidade do quadro) e a cor do
 * painel por baixo do clipe. Roda SOMENTE com `MC_TEST_FFMPEG=1`.
 */
const describeIf = FFMPEG_FIXTURES_ENABLED ? describe : describe.skip;
const MIN_PSNR_DB = 40;
const WINDOW_MARGIN_PX = 8;

describeIf(
  'compose_ffmpeg com ffmpeg real — peça de ofertas sobre o quadro parado (MC_TEST_FFMPEG=1)',
  () => {
    let dir: string;

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-piece-compose-'));
    }, 60_000);

    afterAll(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('quadro 1080×1920 do mock como arte: artRect = quadro inteiro, PSNR ≥ 40 dB fora da janela, clipe no rect do personagem', async () => {
      const W = 1080;
      const H = 1920;
      const document = fixturePieceDocument({
        background: { mode: 'gradient', colors: ['#D32F2F', '#F9A825'], angle: 160 },
        character: { panel: { shape: 'card', color: '#FFE082' } },
      });
      const { props } = buildOfferPieceStillProps({
        document,
        width: W,
        height: H,
        fonts: [],
        assetBaseUrl: 'http://127.0.0.1:3001',
      });
      const still = path.join(dir, 'still.png');
      await new MockStillRenderer({}).renderStill({ props, localFiles: {}, outputPath: still });
      const meta = await sharp(still).metadata();
      expect([meta.width, meta.height]).toEqual([W, H]);

      const clips = [
        { sceneId: 'a', file: path.join(dir, 'a.mp4'), durationS: 1.0, color: 'blue' },
        { sceneId: 'b', file: path.join(dir, 'b.mp4'), durationS: 1.2, color: 'lime' },
      ];
      for (const clip of clips) await tinyClip(clip.file, clip.durationS, clip.color);
      const measured = [];
      for (const clip of clips) {
        const p = await probe(clip.file);
        measured.push({ sceneId: clip.sceneId, durationMs: p.durationMs as number });
      }
      const timeline = composeTimeline(measured, 200);
      const character = document.blocks.find((b) => b.type === 'character')!;
      const input: ComposeGraphInput = {
        format: 'offer_piece',
        aspectRatio: '9:16',
        width: W,
        height: H,
        backgroundArtPath: still,
        artWidth: W,
        artHeight: H,
        window: character.rect,
        logoFace: false,
        backgroundColor: '#FFE082',
        fill: 'color',
        clips: clips.map((c, i) => ({
          sceneId: c.sceneId,
          path: c.file,
          startS: timeline.clips[i].startS,
          endS: timeline.clips[i].endS,
        })),
        gapMs: 200,
        captionsEnabled: false,
        endcard: null,
      };
      const work = path.join(dir, 'compose');
      await fs.mkdir(work, { recursive: true });
      const plan = buildComposeGraph(input, work);
      expect(plan.artRect).toEqual({ x: 0, y: 0, width: W, height: H });
      await runComposePlan(plan);

      const composed = await probe(plan.output);
      expect(composed.width).toBe(W);
      expect(composed.height).toBe(H);
      expect(
        composedOutputIssue(
          {
            hasVideo: composed.hasVideo,
            hasAudio: composed.hasAudio,
            width: composed.width,
            height: composed.height,
            durationMs: composed.durationMs,
          } as never,
          { durationMs: plan.expectedDurationMs, width: W, height: H },
        ),
      ).toBeNull();

      // fidelidade do quadro fora da janela do personagem (quadros falados)
      const ref = await referenceLuma(still, buildArtBaseChain(input), W, H);
      const masks: Rect[] = [inset(plan.windowPx, -WINDOW_MARGIN_PX)];
      for (const t of [0.5, 1.8]) {
        const frame = await lumaAt(plan.output, t, W, H);
        const { psnr, pixels } = psnrMasked(
          frame,
          ref,
          W,
          inset({ x: 0, y: 0, width: W, height: H }, 2),
          masks,
        );
        expect(pixels).toBeGreaterThan(W * H * 0.8);
        expect(psnr).toBeGreaterThanOrEqual(MIN_PSNR_DB);
      }

      // o clipe azul ocupa a janela (rect do personagem) durante a primeira fala
      const px = pieceRectToPx(character.rect, W, H);
      expect(plan.windowPx).toMatchObject({ x: px.x, y: px.y });
      const [r, g, b] = await meanRgbAt(plan.output, 0.5, {
        x: plan.windowPx.x + 20,
        y: plan.windowPx.y + 20,
        width: plan.windowPx.width - 40,
        height: plan.windowPx.height - 40,
      });
      expect(b).toBeGreaterThan(150);
      expect(r).toBeLessThan(80);
      expect(g).toBeLessThan(80);
    }, 120_000);
  },
);
