import { DataSource } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McClipInspectorService } from '../services/mc-clip-inspector.service';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McIngestProcessor } from './mc-ingest.processor';

/**
 * Fixture de QA do provider mock (change video-fala-continua, 1.9): `MC_CLIP_INSPECTION_MOCK` inventa o
 * veredito de texto inventado no clipe do trecho (o clipe mock não passa pelo Gemini). Mesma regra de
 * decisão do veredito real: reprovado abaixo do teto da classe `quality` → erro que regera o TRECHO INTEIRO;
 * no teto → aceito e sinalizado.
 */
describe('McIngestProcessor.inspectClip — fixture de texto inventado do mock', () => {
  const original = process.env.MC_CLIP_INSPECTION_MOCK;
  const processor = new McIngestProcessor(
    {} as DataSource,
    {} as McPipelineService,
    {} as FalQueueClient,
    {} as FfmpegRunner,
    {} as McStorageService,
    {} as McClipInspectorService,
  );
  const step = (attempts: number, provider = 'mock') =>
    ({ id: 'st', provider, phase: 'production', attempts, inputSnapshot: {} }) as unknown as McStep;
  const clip = {
    path: '/tmp/x.mp4',
    durationMs: 5000,
    tempDir: '/tmp',
    talk: true,
    speechWindows: [],
  };
  const inspect = (s: McStep) => processor.inspectClip(s, {} as McProject, clip);

  afterEach(() => {
    if (original === undefined) delete process.env.MC_CLIP_INSPECTION_MOCK;
    else process.env.MC_CLIP_INSPECTION_MOCK = original;
  });

  it('sem a variável o clipe mock não é inspecionado (como sempre)', async () => {
    delete process.env.MC_CLIP_INSPECTION_MOCK;
    await expect(inspect(step(1))).resolves.toBeNull();
  });

  it('`text`: reprova a 1ª e a 2ª execução (regera o trecho) e, no teto de 3 execuções, aceita sinalizado', async () => {
    process.env.MC_CLIP_INSPECTION_MOCK = 'text';
    await expect(inspect(step(1))).rejects.toMatchObject({ code: 'clip_text_detected' });
    await expect(inspect(step(2))).rejects.toMatchObject({ code: 'clip_text_detected' });
    const accepted = await inspect(step(3));
    expect(accepted).toMatchObject({ flagged: true, reasons: ['text'], verdict: 'reprovado' });
  });

  it('`text_once`: só a 1ª execução reprova; a regravação passa limpa', async () => {
    process.env.MC_CLIP_INSPECTION_MOCK = 'text_once';
    await expect(inspect(step(1))).rejects.toMatchObject({ code: 'clip_text_detected' });
    await expect(inspect(step(2))).resolves.toBeNull();
  });

  it('step sem fase (legado) nunca é inspecionado, mesmo com a fixture ligada', async () => {
    process.env.MC_CLIP_INSPECTION_MOCK = 'text';
    await expect(inspect({ ...step(1), phase: null } as unknown as McStep)).resolves.toBeNull();
  });
});
