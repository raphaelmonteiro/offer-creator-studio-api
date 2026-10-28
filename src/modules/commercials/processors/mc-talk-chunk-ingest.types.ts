import type { SpeechWindow } from '../domain/mc-captions';
import type { ChunkSliceSpan } from '../domain/mc-talk-chunk-ffmpeg';
import type { ChunkSnapshot } from '../domain/mc-talk-chunk-step';
import type { TalkConformGate } from './mc-talk-conform-gate';
import type { McProject } from '../entities/mc-project.entity';
import type { McStep } from '../entities/mc-step.entity';
import type { ClipInspection } from '../services/mc-clip-inspector.service';
import type { TalkResolutionRecord } from './mc-ingest.processor';

export interface MeasuredClip {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** Fatia já conformada, em disco (uma por fala do trecho). */
export interface SliceFile extends ChunkSliceSpan {
  path: string;
  measured: MeasuredClip;
}

export interface ConformedChunk {
  fullPath: string;
  measured: MeasuredClip;
  slices: SliceFile[];
  gate: TalkConformGate;
  speechWindows: SpeechWindow[];
  rawDurationMs: number;
  rawWidth: number | null;
  rawHeight: number | null;
  leaderAudioAssetId: string;
}

/** Arquivo publicado no bucket (vídeo + poster + miniatura). */
export interface PublishedVideo {
  assetId: string;
  fileUrl: string;
  posterUrl: string;
  thumbUrl: string;
  size: number;
}

export interface PublishedJoinFrame {
  assetId: string;
  fileUrl: string;
  width: number | null;
  height: number | null;
  size: number;
}

/** Ganchos do processor (inspeção, resolução e custo vivem lá e valem para a fala e para o trecho). */
export interface ChunkIngestHelpers {
  checkResolution(
    step: McStep,
    project: McProject,
    measured: { width: number | null; height: number | null },
  ): Promise<TalkResolutionRecord>;
  inspect(
    step: McStep,
    project: McProject,
    clip: {
      path: string;
      durationMs: number;
      tempDir: string;
      talk: boolean;
      speechWindows: SpeechWindow[];
      identityReference?: boolean;
    },
  ): Promise<ClipInspection | null>;
  billing(
    step: McStep,
    project: McProject,
    rawDurationMs: number | null,
    talk: boolean,
  ): ChunkBilling;
}

export interface ChunkBilling {
  providerCostUsd: number;
  billedDurationMs: number | null;
  engineRecord: Record<string, unknown>;
}

export interface ChunkIngestArgs {
  step: McStep;
  project: McProject;
  chunk: ChunkSnapshot;
  tempDir: string;
  videoPath: string;
  probe: MeasuredClip;
}
