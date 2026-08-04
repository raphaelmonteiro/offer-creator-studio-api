/**
 * FfmpegGraphBuilder (TDD §6.1): transforma um RenderSpec em argumentos de
 * linha de comando do ffmpeg. Classe pura e determinística — spec entra,
 * `{ args, passes }` sai — para ser testável por snapshot sem tocar em I/O.
 *
 * Regras:
 * - Camadas visuais ordenadas por zIndex e encadeadas via overlay com janela
 *   `enable=between(t,start,end)` própria por camada (multi-mascote).
 * - Áudios: adelay por camada + amix quando houver mais de um.
 * - GIF: descarta áudio (validação já avisou), palette em 2 passos.
 * - Limites (validados ANTES de spawnar): ≤4 vídeos, ≤3 áudios, filtro ≤8KB.
 */

export type RenderFormat = 'mp4' | 'webm' | 'gif';

export interface RenderLayer {
  type: 'video' | 'image_overlay' | 'mascot' | 'audio';
  /** Caminho local absoluto do arquivo (resolvido pelo worker antes do build). */
  filePath: string;
  /** Frações do canvas [0..1]. Ignorado para audio. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  startMs?: number;
  endMs?: number;
  loop?: boolean;
  zIndex?: number;
  /** Volume 0..1 (audio). */
  volume?: number;
  /** Mascote com mezanino alpha (VP9 yuva420p) — overlay usa alpha nativo. */
  hasAlpha?: boolean;
}

export interface RenderSpec {
  format: RenderFormat;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  quality: 'draft' | 'standard' | 'high';
  /** Cor de fundo quando não há camada `video` de base (hex sem #). */
  backgroundColor?: string;
  layers: RenderLayer[];
}

export interface BuiltCommand {
  /** Argumentos do ffmpeg (sem o binário), 1 array por passo de execução. */
  passes: string[][];
}

export const GRAPH_LIMITS = {
  maxVideoLayers: 4,
  maxAudioLayers: 3,
  maxFilterBytes: 8 * 1024,
  gifMaxWidth: 480,
  gifFps: 12,
} as const;

export class RenderSpecError extends Error {}

const CRF_BY_QUALITY: Record<RenderSpec['quality'], number> = {
  draft: 28,
  standard: 21,
  high: 18,
};

export class FfmpegGraphBuilder {
  build(spec: RenderSpec, outputPath: string, tmpDir = '/tmp'): BuiltCommand {
    const durationS = spec.durationMs / 1000;
    const visual = spec.layers
      .filter((l) => l.type !== 'audio')
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    const audio = spec.format === 'gif' ? [] : spec.layers.filter((l) => l.type === 'audio');

    const videoCount = visual.filter((l) => l.type === 'video' || l.type === 'mascot').length;
    if (videoCount > GRAPH_LIMITS.maxVideoLayers) {
      throw new RenderSpecError(`Máximo de ${GRAPH_LIMITS.maxVideoLayers} camadas de vídeo`);
    }
    if (audio.length > GRAPH_LIMITS.maxAudioLayers) {
      throw new RenderSpecError(`Máximo de ${GRAPH_LIMITS.maxAudioLayers} camadas de áudio`);
    }
    if (visual.length === 0 && !spec.backgroundColor) {
      throw new RenderSpecError('Render sem camadas visuais nem cor de fundo');
    }

    const inputs: string[] = [];
    const filters: string[] = [];
    let inputIndex = 0;

    // ── Base: primeira camada visual (fundo) ou cor sólida ──
    let baseLabel: string;
    const [first, ...overlays] = visual;
    if (
      first &&
      (first.type === 'video' || first.type === 'image_overlay') &&
      this.coversCanvas(first)
    ) {
      inputIndex = this.pushInput(inputs, first, durationS);
      filters.push(
        `[0:v]scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase,` +
          `crop=${spec.width}:${spec.height},fps=${spec.fps}[base0]`,
      );
      baseLabel = 'base0';
    } else {
      // sem fundo full-canvas: cor sólida como camada 0, todas as visuais viram overlay
      overlays.unshift(...(first ? [first] : []));
      inputs.push(
        '-f',
        'lavfi',
        '-i',
        `color=c=0x${spec.backgroundColor ?? 'ffffff'}:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${durationS}`,
      );
      inputIndex = 1;
      filters.push(`[0:v]null[base0]`);
      baseLabel = 'base0';
    }

    // ── Overlays encadeados por zIndex ──
    overlays.forEach((layer, i) => {
      const idx = inputIndex;
      inputIndex = this.pushInput(inputs, layer, durationS);
      const w = Math.round((layer.w ?? 1) * spec.width);
      const h = Math.round((layer.h ?? 1) * spec.height);
      const x = Math.round((layer.x ?? 0) * spec.width);
      const y = Math.round((layer.y ?? 0) * spec.height);
      const startS = (layer.startMs ?? 0) / 1000;
      const endS = (layer.endMs ?? spec.durationMs) / 1000;
      const label = `ov${i}`;
      filters.push(`[${idx}:v]scale=${w}:${h}[l${i}]`);
      filters.push(
        `[${baseLabel}][l${i}]overlay=${x}:${y}:enable='between(t,${startS},${endS})'[${label}]`,
      );
      baseLabel = label;
    });

    // ── Saída visual por formato ──
    let outLabel = baseLabel;
    if (spec.format === 'gif') {
      const gifW = Math.min(spec.width, GRAPH_LIMITS.gifMaxWidth);
      filters.push(`[${baseLabel}]fps=${GRAPH_LIMITS.gifFps},scale=${gifW}:-2[gifout]`);
      outLabel = 'gifout';
    }

    // ── Áudio ──
    const audioLabels: string[] = [];
    audio.forEach((layer, i) => {
      const idx = inputIndex;
      inputs.push('-i', layer.filePath);
      inputIndex += 1;
      const delay = layer.startMs ?? 0;
      const volume = layer.volume ?? 1;
      filters.push(`[${idx}:a]adelay=${delay}|${delay},volume=${volume}[a${i}]`);
      audioLabels.push(`[a${i}]`);
    });
    let audioMap: string[] = [];
    if (audioLabels.length === 1) {
      filters.push(`${audioLabels[0]}afade=t=out:st=${Math.max(0, durationS - 0.3)}:d=0.3[aout]`);
      audioMap = ['-map', '[aout]'];
    } else if (audioLabels.length > 1) {
      filters.push(
        `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,` +
          `afade=t=out:st=${Math.max(0, durationS - 0.3)}:d=0.3[aout]`,
      );
      audioMap = ['-map', '[aout]'];
    }

    const filterComplex = filters.join(';');
    if (Buffer.byteLength(filterComplex) > GRAPH_LIMITS.maxFilterBytes) {
      throw new RenderSpecError('filter_complex excede o limite de 8KB');
    }

    const common = [
      '-y',
      '-hide_banner',
      ...inputs,
      '-filter_complex',
      filterComplex,
      '-t',
      String(durationS),
      '-threads',
      '2',
    ];

    if (spec.format === 'gif') {
      // 2 passos: palettegen → paletteuse
      const palette = `${tmpDir}/palette.png`;
      const genFilter = `${filterComplex};[${outLabel}]palettegen=stats_mode=diff[pal]`;
      const p1 = [
        '-y',
        '-hide_banner',
        ...inputs,
        '-filter_complex',
        genFilter,
        '-map',
        '[pal]',
        palette,
      ];
      const useFilter = `${filterComplex};[${outLabel}]null[gifv]`;
      const p2 = [
        '-y',
        '-hide_banner',
        ...inputs,
        '-i',
        palette,
        '-filter_complex',
        `${useFilter};[gifv][${inputIndex}:v]paletteuse=dither=bayer:bayer_scale=4[final]`,
        '-map',
        '[final]',
        '-t',
        String(durationS),
        '-threads',
        '2',
        outputPath,
      ];
      return { passes: [p1, p2] };
    }

    const crf = CRF_BY_QUALITY[spec.quality];
    const encode =
      spec.format === 'mp4'
        ? [
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            String(crf),
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
          ]
        : ['-c:v', 'libvpx-vp9', '-crf', String(crf + 12), '-b:v', '0', '-pix_fmt', 'yuv420p'];
    const audioEncode =
      audioMap.length > 0
        ? spec.format === 'mp4'
          ? ['-c:a', 'aac', '-b:a', '128k']
          : ['-c:a', 'libopus']
        : ['-an'];

    return {
      passes: [
        [
          ...common,
          '-map',
          `[${outLabel}]`,
          ...audioMap,
          ...encode,
          ...audioEncode,
          '-shortest',
          outputPath,
        ],
      ],
    };
  }

  private coversCanvas(layer: RenderLayer): boolean {
    return (
      (layer.x ?? 0) === 0 && (layer.y ?? 0) === 0 && (layer.w ?? 1) === 1 && (layer.h ?? 1) === 1
    );
  }

  private pushInput(inputs: string[], layer: RenderLayer, durationS: number): number {
    if (layer.loop) inputs.push('-stream_loop', '-1');
    if (layer.type === 'image_overlay') inputs.push('-loop', '1');
    inputs.push('-t', String(durationS), '-i', layer.filePath);
    // devolve o próximo índice de input
    return inputs.filter((a) => a === '-i').length;
  }
}
