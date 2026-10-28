import { KLING_AVATAR_MODEL, MINIMAX_H3_LIPSYNC_MODEL } from '../domain/mc-pipeline.config';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStep } from '../entities/mc-step.entity';
import {
  chunkStep,
  ChunkHarness,
  createChunkHarness,
  restoreProvider,
} from './mc-talking.processor.chunk.fixture';

/**
 * Submit do `talk` de um TRECHO (change video-fala-continua, 1.4): uma chamada ao motor para N falas,
 * com a emenda dos TTS como áudio e só o tile + áudio + prompt como entrada. Provider falso: nada paga.
 */
describe('McTalkingProcessor — submit de trecho (fala contínua)', () => {
  const originalProvider = process.env.MC_PIPELINE_PROVIDER;
  let h: ChunkHarness;

  beforeEach(async () => {
    h = await createChunkHarness();
  });

  afterEach(() => restoreProvider(originalProvider));

  it('3 falas → UMA chamada ao motor com a emenda dos 3 TTS; entrada = só imagem, áudio e prompt', async () => {
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.pipeline.failStep).not.toHaveBeenCalled();
    expect(h.fal.submit).toHaveBeenCalledTimes(1);
    const [model, input] = h.fal.submit.mock.calls[0] as [string, Record<string, string>];
    expect(model).toBe(KLING_AVATAR_MODEL);
    expect(Object.keys(input).sort()).toEqual(['audio_url', 'image_url', 'prompt']);
    // o áudio enviado é a emenda (saída do ffmpeg), montada a partir dos 3 TTS originais
    expect(Buffer.from(input.audio_url.split(',')[1], 'base64').toString()).toBe('mp3-emendado');
    expect(h.ffmpegInputs.map((b) => b.toString())).toEqual([
      'mp3:/uploads/a-tts-0.bin',
      'mp3:/uploads/a-tts-1.bin',
      'mp3:/uploads/a-tts-2.bin',
    ]);
    const splice = h.ffmpegRuns[0].join(' ');
    expect(splice).toContain('concat=n=5'); // 3 falas + 2 silêncios de 200 ms
    expect(splice).not.toContain('atempo');
    expect(input.prompt).toContain('one continuous take');
    // só o tile (h.kit) e os TTS foram lidos do disco: nenhuma arte, logo, preço ou quadro da peça
    const read = h.storage.readUploadsFile.mock.calls.map((c) => String(c[0]));
    expect(read.every((u) => u.includes('a-tile') || u.includes('a-tts-'))).toBe(true);
    // o snapshot do step guarda o trecho e o registro do envio
    expect(h.transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McStep,
      'st-chunk',
      McStepStatus.RUNNING,
      McStepStatus.PROVIDER_WAIT,
      expect.objectContaining({
        providerJobId: 'req-chunk',
        inputSnapshot: expect.objectContaining({
          chunk: expect.objectContaining({ sceneIds: ['s0', 's1', 's2'] }),
          audioPadding: null,
        }),
      }),
    );
    expect(h.pipeline.consumeStepCredits).toHaveBeenCalledTimes(1);
  });

  it('H3 (logo): o enchimento até 5,15 s é aplicado UMA vez ao trecho; custo estimado sobre os segundos enviados', async () => {
    h.kit.identityMode = 'logo_as_is';
    (h.step.inputSnapshot as Record<string, unknown>) = {
      ...chunkStep(MINIMAX_H3_LIPSYNC_MODEL, [2000, 2000]).snapshot,
      identityMode: 'logo_as_is',
      engine: { key: 'logo', model: MINIMAX_H3_LIPSYNC_MODEL, usdPerSecond: 0.08, maxChunkS: 15 },
    };
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.pipeline.failStep).not.toHaveBeenCalled();
    expect(h.fal.submit).toHaveBeenCalledTimes(1);
    const splice = h.ffmpegRuns[0].join(' ');
    expect(splice).toContain('-t 5.150');
    expect(splice.match(/anullsrc/g)).toHaveLength(2); // 1 gap + 1 enchimento (não por fala)
    const snapshot = (
      h.transitions.casTransition.mock.calls[0][5] as { inputSnapshot: Record<string, unknown> }
    ).inputSnapshot;
    expect(snapshot.audioPadding).toMatchObject({ speechMs: 4200, minS: 5 });
    expect(snapshot.estimatedProviderCostUsd).toBeCloseTo(5.15 * 0.08, 3);
  });

  it('trecho de uma fala sem cauda: o TTS vai como está, sem ffmpeg (igual ao de hoje)', async () => {
    (h.step.inputSnapshot as Record<string, unknown>) = chunkStep(
      KLING_AVATAR_MODEL,
      [3000],
    ).snapshot;
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.ffmpegRuns).toHaveLength(0);
    const [, input] = h.fal.submit.mock.calls[0] as [string, Record<string, string>];
    expect(Buffer.from(input.audio_url.split(',')[1], 'base64').toString()).toBe(
      'mp3:/uploads/a-tts-0.bin',
    );
    expect(input.prompt).toContain('Start and end in a neutral');
  });

  it('TTS de uma das falas ausente do disco → validação terminal, nada enviado ao motor', async () => {
    h.storage.readUploadsFile.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('a-tile') ? h.tilePng : url.includes('a-tts-1') ? null : Buffer.from('mp3'),
      ),
    );
    await h.processor.process({ stepId: 'st-chunk' });
    expect(h.fal.submit).not.toHaveBeenCalled();
    expect(h.pipeline.failStep).toHaveBeenCalledTimes(1);
  });
});
