import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildChunkConformSliceArgs, planChunkSlices } from './mc-talk-chunk-ffmpeg';
import { ChunkSnapshot } from './mc-talk-chunk-step';
import { planTalkChunks } from './mc-talk-chunks';
import { judgeJumps } from './mc-jump-metric';
import { mockPlainPoseFilters } from './mc-mock-pose';
import { buildTalkConformArgs, MC_TALK_GAP_MS, planTalkConform } from './mc-talk-conform-graph';
import {
  buildComposeGraph,
  ComposeGraphInput,
  composeTimeline,
  continuousClipTimes,
} from './mc-talking-art-graph';

/**
 * Continuidade com FFmpeg REAL (change video-fala-continua, 1.6, D14): o mesmo vídeo de 3 falas montado
 * no modo contínuo (um clipe de pose que balança, fatiado) e no modo de hoje (um clipe por fala, cada um
 * recomeçando a pose) — o contínuo passa na métrica de salto em todas as fronteiras; o de hoje a acusa.
 * Roda SOMENTE com `MC_TEST_FFMPEG=1` e binários acessíveis (mesmo gate dos demais fixtures de mídia).
 */
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const ENABLED = process.env.MC_TEST_FFMPEG === '1';
const describeIf = ENABLED ? describe : describe.skip;

function run(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg ${code}: ${err.slice(-500)}`)),
    );
  });
}

const SPEECH_MS = [2168, 1907, 4310];
const FRAME = 240;

describeIf('continuidade da personagem entre falas (D14, ffmpeg real)', () => {
  let dir: string;
  const timeline = composeTimeline(
    SPEECH_MS.map((durationMs, i) => ({ sceneId: `s${i}`, durationMs })),
    MC_TALK_GAP_MS,
  );

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-continuity-'));
  });
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  const tone = async (name: string, ms: number) => {
    const file = path.join(dir, name);
    await run([
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=330:duration=${ms / 1000}`,
      '-ar',
      '44100',
      '-ac',
      '1',
      file,
    ]);
    return file;
  };

  /** Clipe "do motor": pose que balança a partir da fase 0; vídeo sem áudio. */
  const rawClip = async (name: string, seconds: number) => {
    const file = path.join(dir, name);
    await run([
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x2E5E9E:s=720x960:r=30:d=${seconds}`,
      '-vf',
      mockPlainPoseFilters(0, '#2E5E9E').join(','),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      file,
    ]);
    return file;
  };

  const composeInput = (
    clips: ComposeGraphInput['clips'],
    continuous: boolean,
  ): ComposeGraphInput => ({
    format: 'offer_piece',
    aspectRatio: '4:5',
    width: 1080,
    height: 1350,
    backgroundArtPath: null,
    window: { x: 0.1, y: 0.25, w: 0.8, h: 0.6 },
    logoFace: false,
    backgroundColor: '#FFFFFF',
    clips,
    gapMs: MC_TALK_GAP_MS,
    captionsEnabled: false,
    endcard: null,
    ...(continuous ? { continuous: { version: 1 } } : {}),
  });

  async function measure(input: ComposeGraphInput) {
    const plan = buildComposeGraph(input, dir);
    await run(plan.passes[0].args);
    const w = plan.windowPx;
    const raw = await run([
      '-v',
      'error',
      '-i',
      plan.output,
      '-vf',
      `crop=${w.width}:${w.height}:${w.x}:${w.y},scale=${FRAME}:${FRAME},format=gray`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ]);
    const frames: Uint8Array[] = [];
    for (let o = 0; o + FRAME * FRAME <= raw.length; o += FRAME * FRAME) {
      frames.push(raw.subarray(o, o + FRAME * FRAME));
    }
    const boundaries = timeline.clips.slice(1).map((c) => c.startS);
    return judgeJumps(frames, FRAME, FRAME, boundaries);
  }

  it('modo contínuo: um clipe de 8,8 s fatiado por fala NÃO tem salto em nenhuma fronteira', async () => {
    const snapshotChunk = planTalkChunks({
      speeches: SPEECH_MS.map((durationMs, i) => ({ sceneId: `s${i}`, durationMs })),
      engineModel: 'fal-ai/kling-video/ai-avatar/v2/standard',
      engineMaxChunkS: 15,
      chunkMaxS: 10,
    }).chunks[0];
    const chunk = {
      sceneRowIds: snapshotChunk.sceneIds,
      speeches: snapshotChunk.speeches.map((s) => ({ ...s, sceneRowId: s.sceneId })),
      audioMs: snapshotChunk.audioMs,
    } as unknown as ChunkSnapshot;
    const slices = planChunkSlices(chunk);
    const outputs = slices.map((_s, i) => path.join(dir, `slice-${i}.mp4`));
    await run(
      buildChunkConformSliceArgs({
        videoPath: await rawClip('raw-chunk.mp4', 8.885),
        audioPath: await tone('chunk.wav', chunk.audioMs),
        plan: planTalkConform({
          videoMs: 8885,
          audioMs: chunk.audioMs,
          videoWidth: 720,
          videoHeight: 960,
          tileWidth: 720,
          tileHeight: 960,
        }),
        slices,
        audioMs: chunk.audioMs,
        sliceOutputs: outputs,
        fullOutput: path.join(dir, 'chunk-full.mp4'),
      }),
    );
    const times = continuousClipTimes(timeline.clips);
    const verdict = await measure(
      composeInput(
        times.map((t, i) => ({ ...t, path: outputs[i] })),
        true,
      ),
    );
    expect(verdict.boundaries).toHaveLength(2);
    expect(verdict.passed).toBe(true);
  }, 120_000);

  it('modo de hoje: um clipe por fala (cada um recomeça a pose) ACUSA salto na mesma métrica', async () => {
    const clips: ComposeGraphInput['clips'] = [];
    for (const [i, ms] of SPEECH_MS.entries()) {
      const conformed = path.join(dir, `today-${i}.mp4`);
      const plan = planTalkConform({
        videoMs: ms + 100,
        audioMs: ms,
        videoWidth: 720,
        videoHeight: 960,
        tileWidth: 720,
        tileHeight: 960,
      });
      await run(
        buildTalkConformArgs({
          videoPath: await rawClip(`raw-${i}.mp4`, (ms + 100) / 1000),
          audioPath: await tone(`speech-${i}.wav`, ms),
          output: conformed,
          plan,
          audioDurationS: ms / 1000,
        }),
      );
      clips.push({ ...timeline.clips[i], path: conformed });
    }
    const verdict = await measure(composeInput(clips, false));
    expect(verdict.passed).toBe(false);
    expect(verdict.worst).toBeGreaterThan(verdict.limit);
  }, 120_000);
});
