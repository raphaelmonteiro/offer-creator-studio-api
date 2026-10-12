import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { ElevenLabsProvider } from '../../../shared/providers/elevenlabs.provider';
import {
  fixtureCommercialScript,
  fixtureTalkTileScript,
} from '../domain/__fixtures__/mc-script-v2.fixtures';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McVoicesService } from '../services/mc-voices.service';
import {
  estimateSpeechSeconds,
  McTtsProcessor,
  mockTtsMaxS,
  neighbourDialogues,
} from './mc-tts.processor';

describe('TTS por fala com prosódia (change video-formatos-personagem, D7, tarefa 3.6)', () => {
  const script = fixtureTalkTileScript();

  it('neighbourDialogues: falas vizinhas pela identidade da cena (v2); extremos sem vizinho', () => {
    expect(neighbourDialogues(script, { scriptSceneId: 'fx-talk-2', idx: 1 })).toEqual({
      previousText: script.scenes[0].dialogue,
      nextText: script.scenes[2].dialogue,
    });
    expect(neighbourDialogues(script, { scriptSceneId: 'fx-talk-1', idx: 0 })).toEqual({
      previousText: null,
      nextText: script.scenes[1].dialogue,
    });
    expect(neighbourDialogues(script, { scriptSceneId: 'fx-talk-3', idx: 2 })).toEqual({
      previousText: script.scenes[1].dialogue,
      nextText: null,
    });
  });

  it('neighbourDialogues: vizinha talk_tile sem fala conta como ausente; sem roteiro ou cena desconhecida, nada', () => {
    const muted = {
      scenes: [
        { ...script.scenes[0], dialogue: null },
        script.scenes[1],
        { ...script.scenes[2], dialogue: '  ' },
      ],
    };
    expect(neighbourDialogues(muted, { scriptSceneId: 'fx-talk-2', idx: 1 })).toEqual({
      previousText: null,
      nextText: null,
    });
    expect(neighbourDialogues(null, { idx: 0 })).toEqual({ previousText: null, nextText: null });
    expect(neighbourDialogues(script, { scriptSceneId: 'inexistente', idx: 9 })).toEqual({
      previousText: null,
      nextText: null,
    });
  });

  it('neighbourDialogues: SÓ cenas talk_tile recebem contexto — presenter/action_voiceover do F3 e o legado seguem sem (L2)', () => {
    const f3 = fixtureCommercialScript();
    // presenter com vizinha falada (action_voiceover): nada de contexto
    expect(neighbourDialogues(f3, { scriptSceneId: 'fx-scene-presenter', idx: 0 })).toEqual({
      previousText: null,
      nextText: null,
    });
    expect(neighbourDialogues(f3, { scriptSceneId: 'fx-scene-voiceover', idx: 1 })).toEqual({
      previousText: null,
      nextText: null,
    });
    // legado (sem sceneType, localizado pela posição): também sem contexto
    const legacy = {
      scenes: [
        { idx: 0, actionPrompt: 'a', dialogue: 'Primeira fala', durationS: 5 },
        { idx: 1, actionPrompt: 'b', dialogue: 'Fala do meio', durationS: 5 },
        { idx: 2, actionPrompt: 'c', dialogue: 'Última fala', durationS: 5 },
      ],
    };
    expect(neighbourDialogues(legacy, { idx: 1 })).toEqual({ previousText: null, nextText: null });
  });

  it('mock de TTS: 15 chars/s com teto configurável por MC_MOCK_TTS_MAX_S', () => {
    const original = process.env.MC_MOCK_TTS_MAX_S;
    delete process.env.MC_MOCK_TTS_MAX_S;
    expect(mockTtsMaxS()).toBe(20);
    expect(estimateSpeechSeconds('x'.repeat(270))).toBe(18); // 270/15
    expect(estimateSpeechSeconds('x'.repeat(600))).toBe(20); // teto default
    expect(estimateSpeechSeconds('oi')).toBe(1);
    process.env.MC_MOCK_TTS_MAX_S = '12';
    expect(mockTtsMaxS()).toBe(12);
    expect(estimateSpeechSeconds('x'.repeat(270))).toBe(12);
    expect(estimateSpeechSeconds('x'.repeat(270), 30)).toBe(18);
    process.env.MC_MOCK_TTS_MAX_S = 'abc';
    expect(mockTtsMaxS()).toBe(20);
    if (original === undefined) delete process.env.MC_MOCK_TTS_MAX_S;
    else process.env.MC_MOCK_TTS_MAX_S = original;
  });

  describe('McTtsProcessor.process — previous_text/next_text das cenas vizinhas', () => {
    const originalProvider = process.env.MC_PIPELINE_PROVIDER;
    let dir: string;
    let elevenLabs: { synthesizeWithTimestamps: jest.Mock };
    let pipeline: Record<string, jest.Mock>;
    let savedAssets: Array<Record<string, unknown>>;
    let scene: Record<string, unknown>;
    let project: Record<string, unknown>;
    let processor: McTtsProcessor;

    beforeEach(async () => {
      process.env.MC_PIPELINE_PROVIDER = 'real';
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-tts-spec-'));
      savedAssets = [];
      const step = {
        id: 'st-tts',
        projectId: 'p1',
        sceneId: 'sc2',
        sceneGeneration: 1,
        type: McStepType.TTS,
        status: McStepStatus.RUNNING,
        phase: 'preparation',
        projectRevision: 1,
        attempt: 1,
        inputHash: 'hash-tts',
        costCredits: 4,
        attempts: 1,
      };
      scene = {
        id: 'sc2',
        projectId: 'p1',
        idx: 1,
        scriptSceneId: 'fx-talk-2',
        sceneType: 'talk_tile',
        generation: 1,
        dialogue: script.scenes[1].dialogue,
        durationS: 7,
      };
      project = { id: 'p1', userId: 'u1', kitId: 'k1', script };
      const kit = { id: 'k1', userId: 'u1', voiceId: 'voice-row', voiceDelivery: null };
      elevenLabs = {
        synthesizeWithTimestamps: jest
          .fn()
          .mockResolvedValue({ audio: Buffer.from('mp3'), alignment: null }),
      };
      pipeline = {
        claimStep: jest.fn().mockResolvedValue(step),
        completeStepAndAdvance: jest.fn().mockResolvedValue(true),
        failStep: jest.fn().mockResolvedValue(undefined),
      };
      const dataSource = {
        getRepository: jest.fn((entity: unknown) => ({
          findOneBy: jest.fn(() => {
            if (entity === McScene) return Promise.resolve(scene);
            if (entity === McProject) return Promise.resolve(project);
            return Promise.resolve(null);
          }),
          findOneByOrFail: jest.fn(() =>
            entity === McCharacterKit ? Promise.resolve(kit) : Promise.reject(new Error('x')),
          ),
        })),
        transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
          cb({
            getRepository: () => ({
              save: jest.fn((asset: Record<string, unknown>) => {
                const row = { id: 'asset-tts', ...asset };
                savedAssets.push(row);
                return Promise.resolve(row);
              }),
            }),
          }),
        ),
      };
      processor = new McTtsProcessor(
        dataSource as unknown as DataSource,
        pipeline as unknown as McPipelineService,
        elevenLabs as unknown as ElevenLabsProvider,
        {
          resolveProviderVoiceId: jest.fn().mockResolvedValue('prov-voice'),
        } as unknown as McVoicesService,
        {
          createTempDir: jest.fn().mockResolvedValue(dir),
          removeTempDir: jest.fn().mockResolvedValue(undefined),
          probe: jest.fn().mockResolvedValue({ hasVideo: false, hasAudio: true, durationMs: 6400 }),
        } as unknown as FfmpegRunner,
        {
          sceneRelDir: jest.fn().mockReturnValue('commercials/u1/p1/scenes/1/g1'),
          saveFile: jest.fn().mockResolvedValue('/uploads/x/voice.mp3'),
        } as unknown as McStorageService,
      );
    });

    afterEach(async () => {
      if (originalProvider === undefined) delete process.env.MC_PIPELINE_PROVIDER;
      else process.env.MC_PIPELINE_PROVIDER = originalProvider;
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('envia a fala da cena com as falas vizinhas como contexto (nunca faladas) e grava a duração medida', async () => {
      await processor.process({ stepId: 'st-tts' });
      expect(pipeline.failStep).not.toHaveBeenCalled();
      expect(elevenLabs.synthesizeWithTimestamps).toHaveBeenCalledWith(
        expect.objectContaining({
          text: script.scenes[1].dialogue,
          voiceId: 'prov-voice',
          previousText: script.scenes[0].dialogue,
          nextText: script.scenes[2].dialogue,
        }),
      );
      expect(savedAssets[0]).toMatchObject({ kind: 'audio', durationMs: 6400 });
      expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'st-tts' }),
        expect.objectContaining({ outputAssetId: 'asset-tts', consumeOnSuccess: true }),
      );
    });

    it('cena presenter do F3 (vizinha falada) → TTS de sempre: SEM previous_text/next_text (L2)', async () => {
      const f3 = fixtureCommercialScript();
      project = { ...project, script: f3 };
      scene = {
        ...scene,
        id: 'sc0',
        idx: 0,
        scriptSceneId: 'fx-scene-presenter',
        sceneType: 'presenter',
        dialogue: f3.scenes[0].dialogue,
      };
      await processor.process({ stepId: 'st-tts' });
      expect(pipeline.failStep).not.toHaveBeenCalled();
      expect(elevenLabs.synthesizeWithTimestamps).toHaveBeenCalledTimes(1);
      expect(elevenLabs.synthesizeWithTimestamps).toHaveBeenCalledWith(
        expect.objectContaining({
          text: f3.scenes[0].dialogue,
          previousText: null,
          nextText: null,
        }),
      );
    });
  });
});
