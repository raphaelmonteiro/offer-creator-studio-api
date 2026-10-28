import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import {
  GEMINI_VISION_MODEL,
  GeminiImageProvider,
} from '../../../shared/providers/gemini-image.provider';
import { SpeechWindow } from '../domain/mc-captions';
import {
  MC_CLIP_DEFORMED_ERROR_CODE,
  MC_CLIP_IDENTITY_DRIFT_ERROR_CODE,
  MC_CLIP_MOUTH_STILL_ERROR_CODE,
  MC_CLIP_TEXT_ERROR_CODE,
  mcShouldRetry,
} from '../domain/mc-error-classes';
import { McKitSource, McKitStyle } from '../domain/mc-kit-identity';

/**
 * Inspeção automática do clipe gerado (opção B, 24/09; generalizada pela change
 * video-formatos-personagem, D11): depois do download, amostramos quadros e
 * perguntamos ao Gemini (visão) se há texto inventado, rosto/corpo deformado
 * e — dentro das janelas de fala, por PARES de quadros (t, t+0,25 s) — boca
 * parada. O ingest reprova o clipe (classe `quality` → nova geração) até o
 * teto e depois aceita, com o veredito gravado no asset.
 *
 * O prompt é dirigido pelo CONTEXTO (origem, estilo, tipo de fundo): um tile
 * em fundo liso não exige corredor de supermercado nem elementos de cena.
 *
 * Nunca derruba o ingest: desligado (`MC_CLIP_TEXT_CHECK=off`) ou erro ⇒
 * veredito "não inspecionado" (`available: false`), que o ingest grava no
 * asset para a revisão sinalizar.
 */
export type McInspectionReason = 'text' | 'deformation' | 'mouth_still' | 'identity_drift';

export type McMouthCheck = 'checked' | 'skipped' | 'still';

export interface ClipInspectionContext {
  source: McKitSource;
  style: McKitStyle | null;
  /** `plain` = tile em fundo liso (talk); `scene` = cena gerada com cenário (keyframe). */
  backgroundKind: 'plain' | 'scene';
  /** Janelas de fala (s, relativas ao clipe) — vazio = checagem de boca pulada. */
  speechWindows: SpeechWindow[];
  /**
   * Modo sem fundo (video-mascote-transparente, D13): cor-chave do fundo de geração. Presente ⇒ o
   * fundo chapado é INTENCIONAL (nunca defeito) e texto na roupa/corpo continua `unwanted_text`.
   * Ausente = o prompt de sempre, byte a byte.
   */
  cutoutKey?: string | null;
  /**
   * Fala contínua (video-fala-continua, D7): imagem do personagem (tile do kit) para comparar com o clipe
   * de um trecho que parte do último quadro do anterior. Presente ⇒ vai como PRIMEIRA imagem e a checagem
   * `identity_drift` entra no prompt. Ausente = o prompt de sempre, byte a byte.
   */
  identityReference?: Buffer | null;
}

export interface ClipInspection {
  /** true = reprovado por pelo menos um motivo (texto, deformação ou boca parada). */
  flagged: boolean;
  reasons: McInspectionReason[];
  where: string | null;
  description: string;
  frames: number;
  /** Pares de quadros comparados dentro das janelas de fala. */
  pairs: number;
  mouthCheck: McMouthCheck;
  model: string;
  /** false = inspeção indisponível/desligada: clipe aceito com veredito "não inspecionado". */
  available: boolean;
  verdict: 'ok' | 'reprovado' | 'não inspecionado';
}

export const MC_CLIP_INSPECTION_FRAMES = 4;
/** Pares (t, t+0,25 s) dentro das janelas de fala para a boca (D11: 2 a 3 pares). */
export const MC_CLIP_INSPECTION_PAIRS = 3;
export const MC_CLIP_INSPECTION_PAIR_DELTA_S = 0.25;

export const MC_CLIP_INSPECTION_DEFAULT_CONTEXT: ClipInspectionContext = {
  source: 'mascot',
  style: null,
  backgroundKind: 'scene',
  speechWindows: [],
};

const STYLE_WORDS: Record<McKitStyle, string> = {
  cartoon_2d: 'flat 2D cartoon',
  '3d_render': '3D animated-feature style',
  realistic: 'photorealistic',
};

/**
 * Modo sem fundo: o fundo liso da geração é o fundo de recorte (chroma key) — nunca um defeito —, e
 * a proibição de texto vale também no corpo e na roupa (enquadramento de corpo).
 */
const CUTOUT_BACKGROUND_NOTE =
  'The flat solid green or blue background is an INTENTIONAL chroma-key background used to cut ' +
  'the character out later: it is NEVER a defect, so do not report it as deformed or as text. ' +
  'Any text, letters, numbers, scribbles or glyphs that look like writing on the clothing or on ' +
  'the body of the character DO count as unwanted_text, also in a full-body framing.';

/** Prompt de QA dirigido pelo contexto: nunca presume "mascote num corredor de loja". */
export function buildClipInspectionPrompt(ctx: ClipInspectionContext, pairs: number): string {
  const subject =
    ctx.source === 'logo'
      ? "a brand logo character (a logo given a face/mouth, or the logo's own face)"
      : 'a mascot character';
  const style = ctx.style ? ` rendered as ${STYLE_WORDS[ctx.style]}` : '';
  const background =
    ctx.backgroundKind === 'plain'
      ? 'The character stands alone on a PLAIN solid-color background; there is no scene, ' +
        'no props and no shelves — do not expect or require any setting.'
      : 'The character is in a generated setting (for example a store); the printed label of a ' +
        'real product package held by the character or sitting on shelves is expected and NOT unwanted.';
  const lines = [
    `You are the QA reviewer of a short animated commercial. The images are frames sampled from ONE`,
    `generated video clip of ${subject}${style}, speaking to the camera in Brazilian Portuguese.`,
    background,
    ...(ctx.cutoutKey ? [CUTOUT_BACKGROUND_NOTE] : []),
    'Check 1 (unwanted_text): detect text rendered inside the clip by the video generator:',
    'captions, subtitles, signs, boards, banners, posters, price tags, stickers, watermarks or',
    "garbled glyphs that look like writing. Lettering that is part of the character's own logo",
    'design is NOT unwanted.',
    'Check 2 (deformed): face or body melted, duplicated or missing features, extra limbs, broken',
    'identity between frames (clearly a different character).',
  ];
  if (pairs > 0) {
    lines.push(
      `Check 3 (mouth_moving): the LAST ${pairs * 2} images are ${pairs} PAIRS of consecutive frames`,
      '(each pair is 0.25 s apart) taken while the character is speaking. In each pair compare the',
      'mouth: it should visibly change (open/close, shape). Answer mouth_moving=false ONLY if the',
      'mouth is frozen in every pair.',
    );
  } else {
    lines.push('There are no speech-window frame pairs: answer mouth_moving=null.');
  }
  if (ctx.identityReference) {
    lines.push(
      'The FIRST image is NOT part of the clip: it is the reference design of the character.',
      'Check 4 (identity_drift): answer identity_drift=true ONLY if the character in the clip frames',
      'is clearly a different character from the reference (different face, colors, outfit or',
      'proportions); small pose, lighting or compression differences do NOT count.',
    );
  }
  const drift = ctx.identityReference ? ', "identity_drift": true|false' : '';
  lines.push(
    'Answer ONLY with compact JSON: {"unwanted_text": true|false, "where": "top|middle|bottom|null",',
    `"deformed": true|false, "mouth_moving": true|false|null${drift}, "description": "<max 20 words>"}.`,
  );
  return lines.join(' ');
}

/** Prompt legado (cena gerada, sem janelas) — mantido para o snapshot de compatibilidade. */
export const MC_CLIP_INSPECTION_PROMPT = buildClipInspectionPrompt(
  MC_CLIP_INSPECTION_DEFAULT_CONTEXT,
  0,
);

@Injectable()
export class McClipInspectorService {
  private readonly logger = new Logger(McClipInspectorService.name);

  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly gemini: GeminiImageProvider,
  ) {}

  enabled(): boolean {
    return process.env.MC_CLIP_TEXT_CHECK !== 'off';
  }

  /** Quadros em instantes espalhados (evita o 1º quadro, que é o keyframe/tile). */
  static sampleTimesS(durationMs: number, frames: number = MC_CLIP_INSPECTION_FRAMES): number[] {
    const d = Math.max(0.2, durationMs / 1000);
    return Array.from({ length: frames }, (_, i) =>
      Number(((d * (i + 1)) / (frames + 1)).toFixed(2)),
    );
  }

  /**
   * Instantes dos PARES (t, t+Δ) dentro das janelas de fala (D11: 2 a 3
   * pares): `pairs` pares distribuídos pelas janelas cortadas ao clipe —
   * primeiro um por janela, das mais longas para as mais curtas (mais chance de
   * boca em movimento); os que sobram vão para a janela com o maior trecho por
   * par. Cada par fica no centro do seu trecho, então pares da mesma janela
   * nunca se sobrepõem. Uma fala contínua (uma janela só, o caso típico do
   * `talk_tile`) rende os 3 pares; só uma fala curta demais rende menos de 2.
   * Sem janela que caiba nenhum par → lista vazia (checagem pulada e registrada).
   */
  static speechPairTimesS(
    windows: SpeechWindow[],
    durationMs: number,
    pairs: number = MC_CLIP_INSPECTION_PAIRS,
    deltaS: number = MC_CLIP_INSPECTION_PAIR_DELTA_S,
  ): number[] {
    const clipS = durationMs / 1000;
    const usable = windows
      .map((w) => ({ startS: Math.max(0, w.startS), endS: Math.min(w.endS, clipS) }))
      .filter((w) => w.endS - w.startS >= deltaS)
      .sort((a, b) => b.endS - b.startS - (a.endS - a.startS));
    const counts = usable.map(() => 0);
    let left = pairs;
    for (let i = 0; i < usable.length && left > 0; i += 1) {
      counts[i] = 1;
      left -= 1;
    }
    while (left > 0) {
      let best = -1;
      let bestSlotS = 0;
      usable.forEach((w, i) => {
        const lengthS = w.endS - w.startS;
        if ((counts[i] + 1) * deltaS > lengthS + 1e-9) return; // outro par não cabe sem sobrepor
        const slotS = lengthS / (counts[i] + 1);
        if (slotS > bestSlotS) {
          best = i;
          bestSlotS = slotS;
        }
      });
      if (best < 0) break;
      counts[best] += 1;
      left -= 1;
    }
    const starts: number[] = [];
    usable.forEach((w, i) => {
      const segmentS = (w.endS - w.startS) / Math.max(1, counts[i]);
      for (let k = 0; k < counts[i]; k += 1) {
        const t = w.startS + segmentS * k + (segmentS - deltaS) / 2;
        starts.push(Number(Math.max(0, t).toFixed(2)));
      }
    });
    return starts.sort((a, b) => a - b);
  }

  static parseVerdict(text: string): {
    flagged: boolean;
    reasons: McInspectionReason[];
    where: string | null;
    description: string;
    mouthMoving: boolean | null;
  } | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as {
        unwanted_text?: unknown;
        where?: unknown;
        deformed?: unknown;
        mouth_moving?: unknown;
        identity_drift?: unknown;
        description?: unknown;
      };
      if (typeof parsed.unwanted_text !== 'boolean') return null;
      const reasons: McInspectionReason[] = [];
      if (parsed.unwanted_text) reasons.push('text');
      if (parsed.deformed === true) reasons.push('deformation');
      const mouthMoving = typeof parsed.mouth_moving === 'boolean' ? parsed.mouth_moving : null;
      if (mouthMoving === false) reasons.push('mouth_still');
      if (parsed.identity_drift === true) reasons.push('identity_drift');
      return {
        flagged: reasons.length > 0,
        reasons,
        where: typeof parsed.where === 'string' && parsed.where !== 'null' ? parsed.where : null,
        description: typeof parsed.description === 'string' ? parsed.description.slice(0, 200) : '',
        mouthMoving,
      };
    } catch {
      return null;
    }
  }

  /** Código de erro (classe `quality`) do primeiro motivo da reprovação. */
  static errorCodeFor(inspection: ClipInspection): string {
    const first = inspection.reasons[0];
    if (first === 'mouth_still') return MC_CLIP_MOUTH_STILL_ERROR_CODE;
    if (first === 'deformation') return MC_CLIP_DEFORMED_ERROR_CODE;
    if (first === 'identity_drift') return MC_CLIP_IDENTITY_DRIFT_ERROR_CODE;
    return MC_CLIP_TEXT_ERROR_CODE;
  }

  /**
   * Fixture de QA do provider MOCK (`MC_CLIP_INSPECTION_MOCK`, só no worker): o clipe mock não passa pelo Gemini,
   * então este veredito inventado exercita a reprovação por trecho sem chamada paga. `text` reprova toda
   * execução (esgota o teto da classe `quality` e o trecho é aceito sinalizado); `text_once` reprova só a 1ª
   * (o trecho é regravado inteiro e a 2ª passa). Outro valor ou ausente → `null` (mock não inspecionado).
   */
  static mockVerdict(mode: string | undefined, executions: number): ClipInspection | null {
    if (mode !== 'text' && !(mode === 'text_once' && executions <= 1)) return null;
    return {
      flagged: true,
      reasons: ['text'],
      where: 'middle',
      description: 'texto inventado no corpo do personagem (fixture de QA do mock)',
      frames: 0,
      pairs: 0,
      mouthCheck: 'skipped',
      model: 'mock',
      available: true,
      verdict: 'reprovado',
    };
  }

  /** Veredito "não inspecionado": clipe aceito, sinalizado na revisão (D11). */
  static unavailable(reason: string): ClipInspection {
    return {
      flagged: false,
      reasons: [],
      where: null,
      description: reason.slice(0, 200),
      frames: 0,
      pairs: 0,
      mouthCheck: 'skipped',
      model: GEMINI_VISION_MODEL,
      available: false,
      verdict: 'não inspecionado',
    };
  }

  /**
   * Decisão do ingest a partir do veredito: 'retry' = reprova e regera (classe
   * quality), 'accept' = teto de gerações atingido, entrega com registro,
   * 'ok' = limpo, sem veredito ou não inspecionado.
   */
  static decision(
    inspection: ClipInspection | null,
    executionsSoFar: number,
  ): 'retry' | 'accept' | 'ok' {
    if (!inspection?.flagged) return 'ok';
    return mcShouldRetry('quality', executionsSoFar) ? 'retry' : 'accept';
  }

  async inspect(
    videoPath: string,
    durationMs: number,
    tempDir: string,
    ctx: ClipInspectionContext = MC_CLIP_INSPECTION_DEFAULT_CONTEXT,
  ): Promise<ClipInspection> {
    if (!this.enabled()) return McClipInspectorService.unavailable('MC_CLIP_TEXT_CHECK=off');
    try {
      const spread = McClipInspectorService.sampleTimesS(durationMs);
      const pairStarts = McClipInspectorService.speechPairTimesS(ctx.speechWindows, durationMs);
      const times = [
        ...spread,
        ...pairStarts.flatMap((t) => [t, Number((t + MC_CLIP_INSPECTION_PAIR_DELTA_S).toFixed(2))]),
      ];
      const frames: Buffer[] = [];
      for (const [i, t] of times.entries()) {
        const out = path.join(tempDir, `inspect-${i}.jpg`);
        await this.ffmpeg.run(
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            String(t),
            '-i',
            videoPath,
            '-frames:v',
            '1',
            '-q:v',
            '4',
            '-vf',
            'scale=540:-2',
            out,
          ],
          { durationMs: 1000, timeoutMs: 30_000 },
        );
        frames.push(await fs.readFile(out));
      }
      const text = await this.gemini.describeImages({
        prompt: buildClipInspectionPrompt(ctx, pairStarts.length),
        images: ctx.identityReference ? [ctx.identityReference, ...frames] : frames,
      });
      const verdict = McClipInspectorService.parseVerdict(text);
      if (!verdict) {
        this.logger.warn(`Inspeção do clipe: resposta não interpretável: ${text.slice(0, 120)}`);
        return McClipInspectorService.unavailable('resposta não interpretável');
      }
      const mouthCheck: McMouthCheck =
        pairStarts.length === 0 || verdict.mouthMoving === null
          ? 'skipped'
          : verdict.mouthMoving
            ? 'checked'
            : 'still';
      // Sem pares, o modelo não pode reprovar por boca parada.
      const reasons =
        pairStarts.length === 0
          ? verdict.reasons.filter((r) => r !== 'mouth_still')
          : verdict.reasons;
      return {
        flagged: reasons.length > 0,
        reasons,
        where: verdict.where,
        description: verdict.description,
        frames: frames.length,
        pairs: pairStarts.length,
        mouthCheck,
        model: GEMINI_VISION_MODEL,
        available: true,
        verdict: reasons.length > 0 ? 'reprovado' : 'ok',
      };
    } catch (err) {
      this.logger.warn(
        `Inspeção do clipe indisponível (${(err as Error).message}) — clipe aceito como "não inspecionado".`,
      );
      return McClipInspectorService.unavailable((err as Error).message);
    }
  }
}
