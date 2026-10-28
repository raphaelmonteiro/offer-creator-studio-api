import * as sharp from 'sharp';
import { McStepStatus } from '../domain/mc-state-machines';
import {
  ChunkHarness,
  createChunkHarness,
  restoreProvider,
  secondChunkStep,
} from './mc-talking.processor.chunk.fixture';

/** Submit do trecho que parte do último quadro do anterior (change video-fala-continua, 1.4). */
describe('McTalkingProcessor — junção entre trechos (D7): o último quadro do trecho anterior é a imagem do seguinte', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  let h: ChunkHarness;

  beforeEach(async () => {
    h = await createChunkHarness();
  });

  afterEach(() => restoreProvider(originalProvider));

  beforeEach(() => {
    (h.step.inputSnapshot as Record<string, unknown>) = secondChunkStep({
      fromStepHash: 'hash-do-trecho-1',
      backgroundColor: '#00B140',
    }).snapshot;
    h.step.sceneId = 'row-0';
    h.previousSteps = [
      {
        inputHash: 'hash-do-trecho-1',
        status: McStepStatus.SUCCEEDED,
        outputAssetId: 'a-prev-slice',
      },
    ];
  });

  it('envia o quadro de junção no lugar do tile (sem recolorir) e NADA além do personagem', async () => {
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.pipeline.failStep).not.toHaveBeenCalled();
    const [, input] = h.fal.submit.mock.calls[0] as [string, Record<string, string>];
    expect(Object.keys(input).sort()).toEqual(['audio_url', 'image_url', 'prompt']);
    const image = Buffer.from(input.image_url.split(',')[1], 'base64');
    const { data } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0x00, 0xb1, 0x40]); // o quadro, não o tile azul
    const read = h.storage.readUploadsFile.mock.calls.map((c) => String(c[0]));
    expect(read.some((u) => u.includes('a-tile'))).toBe(false);
    expect(read.every((u) => u.includes('a-join') || u.includes('a-tts-'))).toBe(true);
  });

  it('trecho anterior sem o último quadro (ou não concluído) → chunk_join_frame_missing, sem chamada ao motor', async () => {
    h.previousSteps = [];
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.fal.submit).not.toHaveBeenCalled();
    expect(h.pipeline.failStep).toHaveBeenCalledWith(
      expect.anything(),
      McStepStatus.RUNNING,
      expect.objectContaining({ code: 'chunk_join_frame_missing' }),
      expect.anything(),
    );
    expect(h.pipeline.consumeStepCredits).not.toHaveBeenCalled();
  });

  it('trecho anterior que falhou não serve de junção (só succeeded/skipped_cached)', async () => {
    h.previousSteps = [
      {
        inputHash: 'hash-do-trecho-1',
        status: McStepStatus.FAILED,
        outputAssetId: 'a-prev-slice',
      },
    ];
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.fal.submit).not.toHaveBeenCalled();
  });
});
