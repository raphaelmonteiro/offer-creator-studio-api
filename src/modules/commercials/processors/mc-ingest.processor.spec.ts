import { DataSource } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McIngestProcessor } from './mc-ingest.processor';

/**
 * A allowlist em si (hosts válidos/inválidos/http) é testada exaustivamente em
 * domain/mc-pipeline.config.spec — aqui o contrato do PROCESSOR: URL bloqueada
 * falha ANTES de qualquer byte trafegar (fetch nunca é chamado) e a falha cai
 * na política de classes (validação terminal).
 */
describe('McIngestProcessor — anti-SSRF do download (plano §6.8)', () => {
  const step = {
    id: 'st-1',
    projectId: 'p1',
    sceneId: 'sc1',
    sceneGeneration: 1,
    type: McStepType.LIPSYNC,
    status: McStepStatus.INGESTING,
    provider: 'fal-ai/kling-video/ai-avatar/v2/standard',
    providerJobId: 'req-1',
    costCredits: 56,
  };
  const scene = { id: 'sc1', projectId: 'p1', idx: 0, generation: 1, durationS: 10 };
  const project = { id: 'p1', userId: 'u1', title: 'T' };

  let stepRow: Record<string, unknown>;
  let pipeline: { failStep: jest.Mock; completeStepAndAdvance: jest.Mock };
  let fal: { resultVideoUrl: jest.Mock };
  let ffmpeg: {
    createTempDir: jest.Mock;
    removeTempDir: jest.Mock;
    probe: jest.Mock;
    run: jest.Mock;
    finalizeOutput: jest.Mock;
  };
  let fetchSpy: jest.SpyInstance;
  let processor: McIngestProcessor;

  beforeEach(() => {
    stepRow = { ...step };
    pipeline = {
      failStep: jest.fn().mockResolvedValue(undefined),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
    };
    fal = { resultVideoUrl: jest.fn() };
    ffmpeg = {
      createTempDir: jest.fn().mockResolvedValue('/tmp/mc-ingest-fake'),
      removeTempDir: jest.fn().mockResolvedValue(undefined),
      probe: jest.fn(),
      run: jest.fn(),
      finalizeOutput: jest.fn(),
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McStep) return Promise.resolve(stepRow);
          if (entity === McScene) return Promise.resolve(scene);
          if (entity === McProject) return Promise.resolve(project);
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb({})),
    };
    fetchSpy = jest.spyOn(global, 'fetch' as never);
    processor = new McIngestProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      fal as unknown as FalQueueClient,
      ffmpeg as unknown as FfmpegRunner,
      {
        sceneRelDir: jest.fn().mockReturnValue('commercials/u1/p1/scenes/0/g1'),
        prepareStreamTarget: jest.fn(),
        saveFile: jest.fn(),
        mockJobAbsPath: jest.fn(),
      } as unknown as McStorageService,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function expectBlocked(url: string): Promise<void> {
    fal.resultVideoUrl.mockResolvedValue(url);
    await processor.process({
      stepId: 'st-1',
      responseUrl: 'https://queue.fal.run/m/requests/req-1',
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // bloqueio ANTES de qualquer tráfego
    expect(pipeline.failStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'st-1' }),
      McStepStatus.INGESTING,
      expect.any(TerminalProviderError),
      expect.anything(),
    );
    const err = pipeline.failStep.mock.calls[0][2] as TerminalProviderError;
    expect(err.code).toBe('ingest_blocked_host');
  }

  it('host fora da allowlist → validação terminal sem fetch', async () => {
    await expectBlocked('https://evil.com/video.mp4');
  });

  it('sufixo forjado (fal.media.evil.com) → bloqueado', async () => {
    await expectBlocked('https://fal.media.evil.com/video.mp4');
  });

  it('http:// (sem TLS) → bloqueado mesmo em host da fal', async () => {
    await expectBlocked('http://v3.fal.media/files/video.mp4');
  });

  it('host permitido passa da allowlist (fetch é tentado) e falha de rede vira retry transiente', async () => {
    fal.resultVideoUrl.mockResolvedValue('https://v3.fal.media/files/ok/video.mp4');
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    await processor.process({ stepId: 'st-1' });
    expect(fetchSpy).toHaveBeenCalledWith('https://v3.fal.media/files/ok/video.mp4');
    const err = pipeline.failStep.mock.calls[0][2] as Error;
    expect(err.constructor.name).toBe('TransientProviderError');
  });

  it('step fora de ingesting → no-op (nem consulta o resultado)', async () => {
    stepRow.status = McStepStatus.SUCCEEDED;
    await processor.process({ stepId: 'st-1' });
    expect(fal.resultVideoUrl).not.toHaveBeenCalled();
    expect(pipeline.failStep).not.toHaveBeenCalled();
  });

  it('tempdir é limpo mesmo na falha (finally)', async () => {
    fal.resultVideoUrl.mockResolvedValue('https://evil.com/video.mp4');
    await processor.process({ stepId: 'st-1' });
    expect(ffmpeg.removeTempDir).toHaveBeenCalledWith('/tmp/mc-ingest-fake');
  });
});
