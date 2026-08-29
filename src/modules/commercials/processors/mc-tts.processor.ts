import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  ElevenLabsCharacterAlignment,
  ElevenLabsProvider,
} from '../../../shared/providers/elevenlabs.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { syntheticAlignment } from '../domain/mc-captions';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McVoicesService } from '../services/mc-voices.service';

/** Cadeia de modelos do TTS do módulo (plano §5.3): v3 primeiro, multilingual_v2 de resgate. */
export const MC_TTS_PRIMARY_MODEL = 'eleven_v3';
export const MC_TTS_FALLBACK_MODEL = 'eleven_multilingual_v2';

/** Duração do mp3 de silêncio do provider mock (segundos). */
const MOCK_TTS_DURATION_S = 2;

/**
 * Consumer da fila mc.tts (conc. 4, plano §6.4): sintetiza a fala da cena com
 * a VOZ DO KIT (eleven_v3 → fallback multilingual_v2, plano §5.3), salva o
 * asset kind `audio` (contentHash = input_hash do step) e consome o custo no
 * sucesso. O CACHE por hash é resolvido ANTES, na materialização
 * (skipped_cached) — este processor só roda quando não houve hit.
 *
 * MC_PIPELINE_PROVIDER=mock: mp3 de silêncio (2s) gerado por ffmpeg — o e2e
 * completo em mock não gasta um centavo de API.
 */
@Injectable()
export class McTtsProcessor {
  private readonly logger = new Logger(McTtsProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly elevenLabs: ElevenLabsProvider,
    private readonly voices: McVoicesService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
  ) {}

  private provider(): string {
    return process.env.MC_PIPELINE_PROVIDER || 'mock';
  }

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, McStepType.TTS);
    if (!step || !step.sceneId) return;

    const scene = await this.dataSource.getRepository(McScene).findOneBy({ id: step.sceneId });
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!scene || !project) return;

    try {
      if (!scene.dialogue) {
        throw new TerminalProviderError('Cena sem fala não gera TTS', 'scene_without_dialogue');
      }
      const kit = await this.dataSource
        .getRepository(McCharacterKit)
        .findOneByOrFail({ id: project.kitId });
      if (this.provider() !== 'mock' && !kit.voiceId) {
        throw new TerminalProviderError('Kit aprovado sem voz definida', 'kit_voice_missing');
      }

      // Blindagem: kits aprovados antes da correção do resolve guardaram o id
      // da LINHA do catálogo em voiceId (ElevenLabs responde 400 invalid_uid).
      // O resolve aceita ambos os formatos e valida contra o catálogo.
      const providerVoiceId =
        this.provider() === 'mock'
          ? null
          : await this.voices.resolveProviderVoiceId(kit.voiceId as string);
      const { audio, alignment } =
        this.provider() === 'mock'
          ? await this.mockVoice(scene.dialogue)
          : await this.synthesizeWithFallback(scene.dialogue, providerVoiceId as string);

      const relDir = this.storage.sceneRelDir(
        project.userId,
        project.id,
        scene.idx,
        scene.generation,
      );
      const fileUrl = await this.storage.saveFile(relDir, `voice-${Date.now()}.mp3`, audio);

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          kind: 'audio' as const,
          status: 'ready' as const,
          name: `Voz cena ${scene.idx + 1} — ${(scene.dialogue ?? '').slice(0, 40)}`,
          origin: 'ai_generated' as const,
          fileUrl,
          mimeType: 'audio/mpeg',
          fileSize: String(audio.length),
          contentHash: step.inputHash, // lookup de cache §6.3 (materialização)
          metadata: {
            projectId: project.id,
            sceneId: scene.id,
            generation: scene.generation,
            voiceId: kit.voiceId,
            provider: this.provider(),
            // Alinhamento por caractere: fonte das LEGENDAS queimadas da
            // montagem (plano §5.4 — sem ASR). Viaja no asset porque o cache
            // por hash reaproveita o áudio ENTRE projetos: quem reusa o áudio
            // reusa a legenda, sem chamar a ElevenLabs de novo.
            ...(alignment ? { alignment } : {}),
          },
        });
        await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.RUNNING,
          outputAssetId: asset.id,
          provider: this.provider(),
          consumeOnSuccess: true, // síncrono barato: consumo no sucesso (§6.7)
        });
      });
    } catch (err) {
      this.logger.error(`TTS ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, err, { fallbackCode: 'tts_failed' });
    }
  }

  /**
   * eleven_v3 → terminal? tenta multilingual_v2 (transiente já re-tentou no
   * provider). Os dois usam o endpoint `with-timestamps`: mesmo custo de TTS e
   * o alinhamento por caractere sai de graça, que é o que alimenta as legendas
   * queimadas (plano §5.4). Alinhamento ausente na resposta não é erro — o
   * comercial sai sem legenda naquela cena.
   */
  private async synthesizeWithFallback(
    text: string,
    voiceId: string,
  ): Promise<{ audio: Buffer; alignment: ElevenLabsCharacterAlignment | null }> {
    try {
      return await this.elevenLabs.synthesizeWithTimestamps({
        text,
        voiceId,
        modelId: MC_TTS_PRIMARY_MODEL,
      });
    } catch (err) {
      if (!(err instanceof TerminalProviderError)) throw err;
      this.logger.warn(`TTS ${MC_TTS_PRIMARY_MODEL} falhou (${err.message}) — fallback.`);
      return this.elevenLabs.synthesizeWithTimestamps({
        text,
        voiceId,
        modelId: MC_TTS_FALLBACK_MODEL,
      });
    }
  }

  /** Voz mock: tom baixo + alinhamento SINTÉTICO uniforme (legendas rodam no e2e de custo zero). */
  private async mockVoice(
    dialogue: string,
  ): Promise<{ audio: Buffer; alignment: ElevenLabsCharacterAlignment }> {
    return {
      audio: await this.mockSilentMp3(),
      alignment: syntheticAlignment(dialogue, MOCK_TTS_DURATION_S),
    };
  }

  /**
   * mp3 de "fala" mock via ffmpeg — provider mock, custo zero. Tom baixo em vez
   * de silêncio absoluto: o loudnorm da montagem produz ganho NaN sobre
   * silêncio digital puro e derruba o encoder AAC ("Input contains NaN/Inf").
   */
  private async mockSilentMp3(): Promise<Buffer> {
    const dir = await this.ffmpeg.createTempDir('mc-tts-mock-');
    const out = path.join(dir, 'silence.mp3');
    try {
      await this.ffmpeg.run(
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=44100',
          '-af',
          'volume=0.05',
          '-t',
          String(MOCK_TTS_DURATION_S),
          '-codec:a',
          'libmp3lame',
          '-q:a',
          '9',
          out,
        ],
        { durationMs: MOCK_TTS_DURATION_S * 1000, timeoutMs: 60_000 },
      );
      return await fs.readFile(out);
    } finally {
      await this.ffmpeg.removeTempDir(dir);
    }
  }
}
