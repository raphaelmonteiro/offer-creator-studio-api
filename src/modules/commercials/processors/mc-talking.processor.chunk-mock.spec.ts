import { McStepStatus } from '../domain/mc-state-machines';
import {
  ChunkHarness,
  createChunkHarness,
  restoreProvider,
  secondChunkStep,
} from './mc-talking.processor.chunk.fixture';

/** Clipe mock do trecho, com pose gated por `MC_MOCK_POSE` (change video-fala-continua, 1.9). */
describe('McTalkingProcessor — provider mock: clipe do trecho com pose que muda com o tempo (1.9)', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  let h: ChunkHarness;

  beforeEach(async () => {
    h = await createChunkHarness();
  });

  afterEach(() => restoreProvider(originalProvider));

  beforeEach(() => {
    process.env.MC_PIPELINE_PROVIDER = 'mock';
  });

  const clipRun = () => h.ffmpegRuns[h.ffmpegRuns.length - 1];

  it('uma chamada para o trecho: duração = áudio ENVIADO + margem, áudio muxado = a emenda, pose recomeçando em 0 no 1º trecho', async () => {
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.fal.submit).not.toHaveBeenCalled();
    expect(h.ffmpegRuns).toHaveLength(2); // emenda + clipe
    const args = clipRun();
    expect(args[args.indexOf('lavfi') + 2]).toBe('color=c=0x2E5E9E:s=720x960:r=30:d=8.885');
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toContain('drawbox');
    expect(vf).toContain("rotate=a='0.4*asin(sin(2*PI*(t+0)/8))*2/PI'");
    expect(args).not.toContain('-shortest');
    expect(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1]).toBe('1:a');
  });

  it('modo de hoje (talk sem trecho): o clipe mock é o de sempre, SEM pose, a menos que MC_MOCK_POSE=on (a medição do salto)', async () => {
    (h.step.inputSnapshot as Record<string, unknown>) = {
      audioAssetId: 'a-tts-0',
      tileAssetId: 'a-tile',
    };
    delete process.env.MC_MOCK_POSE;
    await h.processor.process({ stepId: 'st-chunk' });
    expect(clipRun()).not.toContain('-vf');
    h.ffmpegRuns.length = 0;
    process.env.MC_MOCK_POSE = 'on';
    try {
      await h.processor.process({ stepId: 'st-chunk' });
      const vf = clipRun()[clipRun().indexOf('-vf') + 1];
      expect(vf).toContain("rotate=a='0.4*asin(sin(2*PI*(t+0)/8))*2/PI'"); // recomeça em 0 a cada clipe
    } finally {
      delete process.env.MC_MOCK_POSE;
    }
  });

  it('trecho com junção continua a pose da fase absoluta (instante do trecho no vídeo) e exige o quadro anterior', async () => {
    const built = secondChunkStep({ fromStepHash: 'h-1', backgroundColor: '#FFFFFF' });
    (h.step.inputSnapshot as Record<string, unknown>) = built.snapshot;
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.pipeline.failStep).toHaveBeenCalledWith(
      expect.anything(),
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'chunk_join_frame_missing' }),
      expect.anything(),
    );
    h.pipeline.failStep.mockClear();
    h.previousSteps = [
      { inputHash: 'h-1', status: McStepStatus.SUCCEEDED, outputAssetId: 'a-prev-slice' },
    ];
    h.ffmpegRuns.length = 0;
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.pipeline.failStep).not.toHaveBeenCalled();
    const vf = clipRun()[clipRun().indexOf('-vf') + 1];
    expect(vf).toContain('(t+9)'); // 9,0 s = onde este trecho começa no vídeo
  });
});
