import { TextCue } from './mc-captions';
import { McSealProduct } from './mc-types';

/**
 * Grafo de montagem final (plano-comerciais §5.1 etapa 6) — funções PURAS que
 * constroem os argumentos do ffmpeg; o mc-assembly.processor só executa via
 * FfmpegRunner (sandbox/timeout/progresso). Puras = testáveis sem spawnar
 * ffmpeg, e o "AssemblyGraphBuilder" previsto no plano §11 nasce testado.
 *
 * Pipeline (v1-B1, multi-cena):
 * 1. normaliza cada clipe no formato do projeto (9:16 720x1280 · 1:1 960x960 ·
 *    16:9 1280x720), h264 yuv420p 30fps, áudio AAC 48kHz estéreo (anullsrc
 *    quando o clipe é mudo), +faststart;
 * 2. cartela final opcional (2s, cor sólida neutra + nome da loja) gerada com
 *    os MESMOS parâmetros para entrar no concat;
 * 3. concat por demuxer (-c copy — tudo já uniforme);
 * 4. passe final: selos por produto + legendas queimadas (drawtext com
 *    `enable=between`), trilha instrumental com DUCKING sob a fala
 *    (sidechaincompress) e loudness -14 LUFS.
 *
 * DECISÃO — legenda por `drawtext` e não por `subtitles`/ASS: o filtro
 * `subtitles` depende de libass no build do ffmpeg (não garantido nos builds
 * do container/VM e ausente em vários builds estáticos), enquanto `drawtext`
 * já é o caminho provado em produção neste projeto (o selo da v0 usa drawtext
 * e funciona). `enable='between(t,a,b)'` liga/desliga cada linha no intervalo
 * do TTS — mesma expressividade que a ASS precisaria aqui, sem dependência
 * opcional de build.
 */

export const ASSEMBLY_FPS = 30;

/** Dimensões 9:16 (default histórico — mantidas exportadas por compatibilidade). */
export const ASSEMBLY_WIDTH = 720;
export const ASSEMBLY_HEIGHT = 1280;

export interface AssemblyDimensions {
  width: number;
  height: number;
}

/** Resolução de saída por formato (contrato v1-B1). Desconhecido → 9:16. */
export function assemblyDimensions(aspectRatio: string | null | undefined): AssemblyDimensions {
  if (aspectRatio === '1:1') return { width: 960, height: 960 };
  if (aspectRatio === '16:9') return { width: 1280, height: 720 };
  return { width: ASSEMBLY_WIDTH, height: ASSEMBLY_HEIGHT };
}

/**
 * Escape do texto do drawtext (ordem importa: '\' primeiro). Cobre os
 * metacaracteres do parser de filtro do ffmpeg: \ : ' % e quebras de linha —
 * um selo "Oferta: R$ 9,90" chega intacto ao vídeo.
 */
export function escapeDrawtextText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

/** Texto do selo determinístico de um produto: "NOME — R$ preço" (plano §5.4). */
export function formatSealText(product: McSealProduct): string {
  const name = product.name.trim().toUpperCase();
  // O preço pode chegar do catálogo já com "R$"; nunca duplicar o símbolo.
  const price = product.price.trim().replace(/^R\$\s*/i, '');
  return `${name} — R$ ${price}`;
}

export interface SceneWindow {
  idx: number;
  startS: number;
  endS: number;
}

/**
 * Selos por cena (contrato v1-B1): um produto por cena, rotativo, exibido a
 * partir da SEGUNDA METADE da cena (o mascote aparece primeiro, o preço entra
 * depois) até o fim dela. Sem produtos → nenhum selo.
 */
export function buildSealCues(scenes: SceneWindow[], products: McSealProduct[]): TextCue[] {
  const list = products.filter((p) => p?.name?.trim() && p?.price?.trim());
  if (list.length === 0) return [];
  return scenes
    .map((scene, position) => {
      const product = list[position % list.length];
      const startS = scene.startS + (scene.endS - scene.startS) / 2;
      return { text: formatSealText(product), startS, endS: scene.endS };
    })
    .filter((cue) => cue.endS > cue.startS);
}

export interface NormalizeClipOptions {
  input: string;
  output: string;
  /** Clipe sem trilha de áudio ganha silêncio (anullsrc) para o concat ser uniforme. */
  hasAudio: boolean;
  durationS: number;
  /** Formato de saída; default 9:16 (comportamento da v0). */
  width?: number;
  height?: number;
}

/** Passe 1 — normalização de um clipe para o formato comum do concat. */
export function buildNormalizeArgs(opts: NormalizeClipOptions): string[] {
  const width = opts.width ?? ASSEMBLY_WIDTH;
  const height = opts.height ?? ASSEMBLY_HEIGHT;
  const filter =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
    `fps=${ASSEMBLY_FPS},format=yuv420p`;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', opts.input];
  if (!opts.hasAudio) {
    args.push('-f', 'lavfi', '-t', String(opts.durationS), '-i', 'anullsrc=r=48000:cl=stereo');
  }
  args.push(
    '-map',
    '0:v:0',
    '-map',
    opts.hasAudio ? '0:a:0' : '1:a:0',
    '-vf',
    filter,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-shortest',
    opts.output,
  );
  return args;
}

/** Duração da cartela final (plano/contrato: 2s). */
export const ENDCARD_DURATION_S = 2;

/** Cor sólida neutra da cartela — cinza-escuro (nunca a cor de outra marca). */
export const ENDCARD_BG_COLOR = '0x1F2430';

export interface EndcardOptions {
  output: string;
  storeName: string;
  width?: number;
  height?: number;
  durationS?: number;
}

/**
 * Passe 2 — cartela final determinística: cor sólida + nome da loja centrado
 * (drawtext), com trilha de silêncio e os MESMOS parâmetros de encode dos
 * clipes normalizados (senão o concat por demuxer recusa).
 */
export function buildEndcardArgs(opts: EndcardOptions): string[] {
  const width = opts.width ?? ASSEMBLY_WIDTH;
  const height = opts.height ?? ASSEMBLY_HEIGHT;
  const durationS = opts.durationS ?? ENDCARD_DURATION_S;
  const draw =
    `drawtext=text='${escapeDrawtextText(opts.storeName)}':` +
    `fontsize=${Math.round(width / 12)}:fontcolor=white:` +
    `x=(w-text_w)/2:y=(h-text_h)/2`;
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${ENDCARD_BG_COLOR}:s=${width}x${height}:r=${ASSEMBLY_FPS}:d=${durationS}`,
    '-f',
    'lavfi',
    '-t',
    String(durationS),
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-vf',
    `${draw},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-shortest',
    opts.output,
  ];
}

/** Conteúdo do arquivo de lista do concat demuxer (aspas simples escapadas no formato do ffmpeg). */
export function buildConcatListContent(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/** Passe 3 — concat por demuxer, sem re-encode (clipes já uniformes). */
export function buildConcatArgs(listPath: string, output: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    output,
  ];
}

/** Loudness alvo do master (padrão social, plano §5.1). */
export const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';

/** Volume da trilha antes do ducking (a compressão sidechain faz o resto). */
export const MUSIC_BASE_VOLUME = 0.35;

/**
 * Ducking da trilha sob a fala (plano §5.1 etapa 6): a fala é a entrada de
 * CONTROLE (sidechain) e a música é comprimida quando o mascote fala.
 */
export const MUSIC_DUCKING_FILTER =
  'sidechaincompress=threshold=0.02:ratio=12:attack=20:release=500:makeup=1';

export interface DrawTextStyle {
  fontSize: number;
  /** Posição vertical (expressão do ffmpeg). */
  y: string;
  boxColor: string;
  boxBorder: number;
}

/**
 * Estilo do selo: terço inferior, caixa semi-transparente (plano §5.4).
 *
 * A fonte ENCOLHE conforme o texto cresce para caber na margem segura (90% da
 * largura). Sem isso, "ARROZ TIO JOÃO 5KG — R$ 24,90" a `width/16` estourava a
 * tela e o preço saía cortado — defeito pego no primeiro vídeo multi-cena
 * montado, invisível em teste unitário porque só aparece no pixel.
 * Aproximação de largura: a fonte default do ffmpeg tem avanço médio ≈ 0,52×
 * o corpo; usamos 0,55 para folga.
 */
export const SEAL_SAFE_WIDTH_RATIO = 0.9;
const AVG_GLYPH_RATIO = 0.55;

export function sealStyle(width: number, text?: string): DrawTextStyle {
  const base = Math.round(width / 16);
  const chars = text?.length ?? 0;
  const maxByWidth = chars
    ? Math.floor((width * SEAL_SAFE_WIDTH_RATIO) / (chars * AVG_GLYPH_RATIO))
    : base;
  return {
    // piso de 22px: abaixo disso o selo vira ilegível em 9:16 — melhor o texto
    // longo tocar as bordas da margem do que sumir.
    fontSize: Math.max(22, Math.min(base, maxByWidth)),
    y: 'h*0.72',
    boxColor: 'black@0.55',
    boxBorder: 18,
  };
}

/**
 * Estilo da legenda: base da tela com MARGEM SEGURA (12% da altura — a UI de
 * Reels/Stories cobre o rodapé em 9:16), caixa semi-transparente, fonte default.
 */
export function captionStyle(width: number, height: number): DrawTextStyle {
  return {
    fontSize: Math.round(width / 22),
    y: `h-${Math.round(height * 0.12)}-text_h`,
    boxColor: 'black@0.6',
    boxBorder: 14,
  };
}

/** Um drawtext com janela de tempo (`enable=between`), centrado no eixo X. */
export function buildTimedDrawtext(cue: TextCue, style: DrawTextStyle): string {
  return (
    `drawtext=text='${escapeDrawtextText(cue.text)}':` +
    `fontsize=${style.fontSize}:fontcolor=white:` +
    `box=1:boxcolor=${style.boxColor}:boxborderw=${style.boxBorder}:` +
    `x=(w-text_w)/2:y=${style.y}:` +
    `enable='between(t,${cue.startS.toFixed(2)},${cue.endS.toFixed(2)})'`
  );
}

export interface FinalizeOptions {
  input: string;
  output: string;
  /** Formato do projeto — define fontes/posições (default 9:16). */
  width?: number;
  height?: number;
  /** Selo de TEXTO único (compat v0): desenhado o vídeo inteiro. */
  sealText?: string | null;
  /** Selos por cena (v1-B1) — vencem o sealText quando presentes. */
  sealCues?: TextCue[];
  /** Legendas queimadas (v1-B1). */
  captionCues?: TextCue[];
  /** Trilha instrumental já baixada; null = sem música (ou music_skipped). */
  musicPath?: string | null;
}

/**
 * Passe 4 — selos + legendas + trilha com ducking + loudnorm -14 LUFS.
 *
 * - Sem música: mantém o caminho simples da v0 (`-vf`/`-af`), com `-c:v copy`
 *   quando também não há nada a desenhar.
 * - Com música: `-filter_complex` com a fala como sidechain do compressor,
 *   `amix` com a fala e loudnorm no master. `duration=first` prende a saída ao
 *   tamanho do vídeo (a trilha é gerada com folga e sobra é descartada).
 */
export function buildFinalizeArgs(opts: FinalizeOptions): string[] {
  const width = opts.width ?? ASSEMBLY_WIDTH;
  const height = opts.height ?? ASSEMBLY_HEIGHT;
  const drawFilters = buildOverlayFilters(opts, width, height);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', opts.input];

  if (opts.musicPath) {
    args.push('-i', opts.musicPath);
    const videoChain = drawFilters.length > 0 ? `[0:v]${drawFilters.join(',')}[v]` : '[0:v]null[v]';
    const filterComplex = [
      videoChain,
      `[1:a]volume=${MUSIC_BASE_VOLUME},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[music]`,
      `[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[voice][sc]`,
      `[music][sc]${MUSIC_DUCKING_FILTER}[ducked]`,
      `[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0,${LOUDNORM_FILTER}[a]`,
    ].join(';');
    args.push(
      '-filter_complex',
      filterComplex,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
    );
  } else if (drawFilters.length > 0) {
    args.push('-vf', drawFilters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
    args.push('-af', LOUDNORM_FILTER);
  } else {
    args.push('-c:v', 'copy', '-af', LOUDNORM_FILTER);
  }

  args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', opts.output);
  return args;
}

/** Cadeia de drawtext do passe final: selos primeiro, legendas por cima. */
function buildOverlayFilters(opts: FinalizeOptions, width: number, height: number): string[] {
  const filters: string[] = [];
  const seals = opts.sealCues ?? [];
  if (seals.length > 0) {
    // estilo POR CUE: cada selo encolhe conforme o próprio texto (produtos têm
    // nomes de tamanhos bem diferentes).
    for (const cue of seals) filters.push(buildTimedDrawtext(cue, sealStyle(width, cue.text)));
  } else {
    const legacy = opts.sealText?.trim();
    if (legacy) {
      const style = sealStyle(width, legacy);
      filters.push(
        `drawtext=text='${escapeDrawtextText(legacy)}':` +
          `fontsize=${style.fontSize}:fontcolor=white:` +
          `box=1:boxcolor=${style.boxColor}:boxborderw=${style.boxBorder}:` +
          `x=(w-text_w)/2:y=${style.y}`,
      );
    }
  }
  const captionStyleValue = captionStyle(width, height);
  for (const cue of opts.captionCues ?? []) {
    filters.push(buildTimedDrawtext(cue, captionStyleValue));
  }
  return filters;
}

/** Poster do frame 0 (JPEG qualidade alta) — base do thumb de 320px via sharp. */
export function buildPosterArgs(input: string, output: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    output,
  ];
}

/** Trilha MOCK: tom contínuo baixo (custo zero) no lugar da ElevenLabs Music. */
export function buildMockMusicArgs(output: string, durationS: number): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=44100',
    '-af',
    'volume=0.08',
    '-t',
    String(Math.max(1, Math.round(durationS))),
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '7',
    output,
  ];
}
