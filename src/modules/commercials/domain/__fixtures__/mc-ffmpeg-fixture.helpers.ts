import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as sharp from 'sharp';
import { buildConcatListContent } from '../mc-assembly-graph';
import { ComposeGraphPlan } from '../mc-talking-art-graph';
import { WindowPx } from '../mc-talking-art-window';

/**
 * Utilitários das fixtures com FFmpeg REAL do F1 (tarefas 4.4/4.5) — só
 * usados pelos specs gated por `MC_TEST_FFMPEG=1`: executar o ffmpeg, sondar,
 * gerar clipes/artes sintéticos, ler o plano Y de um quadro, PSNR de luma com
 * máscara, loudness momentânea (ebur128) e a ordem dos átomos do MP4.
 */
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
export const FFMPEG_FIXTURES_ENABLED = process.env.MC_TEST_FFMPEG === '1';

export function runBin(bin: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-20_000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout: Buffer.concat(out), stderr: err })
        : reject(new Error(`${bin} ${code}: ${err.slice(-600)}`)),
    );
  });
}

export const ffmpeg = (args: string[]) => runBin(FFMPEG, ['-nostdin', ...args]);

export interface ProbeInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  profile: string | null;
  level: number | null;
  hasBFrames: number | null;
  rFrameRate: string | null;
  avgFrameRate: string | null;
  audioCodec: string | null;
  audioRate: number | null;
  sizeBytes: number | null;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { stdout } = await runBin(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  const json = JSON.parse(stdout.toString()) as {
    streams?: Array<Record<string, unknown>>;
    format?: { duration?: string; size?: string };
  };
  const video = json.streams?.find((s) => s.codec_type === 'video');
  const audio = json.streams?.find((s) => s.codec_type === 'audio');
  const durationS = Number(json.format?.duration);
  return {
    hasVideo: !!video,
    hasAudio: !!audio,
    durationMs: Number.isFinite(durationS) ? Math.round(durationS * 1000) : null,
    width: (video?.width as number) ?? null,
    height: (video?.height as number) ?? null,
    profile: (video?.profile as string) ?? null,
    level: (video?.level as number) ?? null,
    hasBFrames: (video?.has_b_frames as number) ?? null,
    rFrameRate: (video?.r_frame_rate as string) ?? null,
    avgFrameRate: (video?.avg_frame_rate as string) ?? null,
    audioCodec: (audio?.codec_name as string) ?? null,
    audioRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    sizeBytes: json.format?.size ? Number(json.format.size) : null,
  };
}

/**
 * Clipe "conformado" sintético: cor sólida no aspecto do tile + o "TTS" (tom,
 * ou qualquer fonte lavfi em `audio`), duração exata.
 */
export async function tinyClip(
  file: string,
  durationS: number,
  color: string,
  opts: { size?: string; frequency?: number; audio?: string } = {},
): Promise<void> {
  await ffmpeg([
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${opts.size ?? '720x960'}:r=30:d=${durationS}`,
    '-f',
    'lavfi',
    '-t',
    String(durationS),
    '-i',
    opts.audio ?? `sine=frequency=${opts.frequency ?? 440}:sample_rate=48000`,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    String(durationS),
    file,
  ]);
}

/**
 * Arte sintética "de encarte": fundo em degradê, blocos de cor, texto miúdo e
 * preços — bordas nítidas, o pior caso para o PSNR (texto fino).
 */
export async function syntheticArt(file: string, width: number, height: number): Promise<void> {
  const rows: string[] = [];
  const cols = 3;
  const cellW = Math.floor((width - 80) / cols);
  const cellH = Math.floor(cellW * 0.9);
  const rowsCount = Math.max(1, Math.floor((height - 260) / (cellH + 20)));
  for (let r = 0; r < rowsCount; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = 40 + c * cellW;
      const y = 200 + r * (cellH + 20);
      const hue = (r * 70 + c * 40) % 360;
      rows.push(
        `<rect x="${x + 6}" y="${y}" width="${cellW - 12}" height="${cellH}" rx="18" fill="hsl(${hue},70%,92%)" stroke="hsl(${hue},60%,40%)" stroke-width="4"/>`,
        `<circle cx="${x + cellW / 2}" cy="${y + cellH * 0.38}" r="${cellH * 0.22}" fill="hsl(${(hue + 180) % 360},65%,55%)"/>`,
        `<text x="${x + 20}" y="${y + cellH * 0.72}" font-family="DejaVu Sans" font-size="${Math.round(cellW / 13)}" fill="#222">Feijão Carioca 1kg</text>`,
        `<text x="${x + 20}" y="${y + cellH * 0.9}" font-family="DejaVu Sans" font-weight="bold" font-size="${Math.round(cellW / 6)}" fill="#C8102E">R$ ${(r * 3 + c + 4).toFixed(2).replace('.', ',')}</text>`,
      );
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE7A3"/><stop offset="1" stop-color="#F28C28"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<rect x="0" y="0" width="${width}" height="170" fill="#C8102E"/>` +
    `<text x="40" y="115" font-family="DejaVu Sans" font-weight="bold" font-size="80" fill="#fff">OFERTAS DA SEMANA</text>` +
    rows.join('') +
    `<text x="40" y="${height - 30}" font-family="DejaVu Sans" font-size="22" fill="#333">Ofertas válidas enquanto durarem os estoques. Imagens meramente ilustrativas.</text>` +
    `</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

/** Executa os passes de um plano de compose (gravando a lista do concat antes do passe `concat`). */
export async function runComposePlan(plan: ComposeGraphPlan): Promise<void> {
  for (const pass of plan.passes) {
    if (pass.label === 'concat') {
      await fs.writeFile(plan.concatListPath, buildConcatListContent(plan.concatInputs));
    }
    await ffmpeg(pass.args);
  }
}

/** Plano Y (luma, faixa limitada BT.601 do yuv420p) de um quadro do vídeo no instante `t`. */
export async function lumaAt(
  file: string,
  t: number,
  width: number,
  height: number,
): Promise<Buffer> {
  const { stdout } = await ffmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    t.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv420p',
    '-',
  ]);
  return stdout.subarray(0, width * height);
}

/**
 * Referência: a arte passada pela MESMA cadeia de base do compose
 * (`[0:v]...[base]`), convertida para yuv420p — só o plano Y.
 */
export async function referenceLuma(
  artPath: string,
  baseChain: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const { stdout } = await ffmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-loop',
    '1',
    '-framerate',
    '30',
    '-t',
    '0.1',
    '-i',
    artPath,
    '-filter_complex',
    baseChain,
    '-map',
    '[base]',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv420p',
    '-',
  ]);
  return stdout.subarray(0, width * height);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const inside = (r: Rect, x: number, y: number) =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/** Retângulo encolhido (positivo) ou expandido (negativo) por `m` px. */
export function inset(r: Rect, m: number): Rect {
  return { x: r.x + m, y: r.y + m, width: r.width - 2 * m, height: r.height - 2 * m };
}

/**
 * PSNR de luma (dB) de `a` contra `b` (planos Y de `width` px) só nos pixels
 * dentro de `region` e fora de todas as `masks`. Também devolve a contagem
 * de pixels comparados (prova de que a máscara não engoliu tudo).
 */
export function psnrMasked(
  a: Buffer,
  b: Buffer,
  width: number,
  region: Rect,
  masks: Rect[],
): { psnr: number; pixels: number } {
  let sum = 0;
  let n = 0;
  const y0 = Math.max(0, region.y);
  const x0 = Math.max(0, region.x);
  for (let y = y0; y < region.y + region.height; y += 1) {
    for (let x = x0; x < region.x + region.width; x += 1) {
      if (masks.some((m) => inside(m, x, y))) continue;
      const i = y * width + x;
      const d = a[i] - b[i];
      sum += d * d;
      n += 1;
    }
  }
  const mse = n > 0 ? sum / n : 0;
  return { psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse), pixels: n };
}

/** Média RGB de uma região do quadro no instante `t`. */
export async function meanRgbAt(file: string, t: number, rect: WindowPx): Promise<number[]> {
  const { stdout } = await ffmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    t.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y},scale=1:1:flags=area`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  return [stdout[0], stdout[1], stdout[2]];
}

/** Instantes (s) em que o áudio SAI do silêncio (início de cada fala), via silencedetect. */
export async function speechOnsets(file: string, durationS: number): Promise<number[]> {
  const { stderr } = await ffmpeg([
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-vn',
    '-af',
    'silencedetect=n=-45dB:d=0.08',
    '-f',
    'null',
    '-',
  ]);
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  // começa falando em t=0 quando não há silêncio inicial
  const onsets = starts.length === 0 || starts[0] > 0.05 ? [0] : [];
  return [...onsets, ...ends.filter((t) => t < durationS - 0.05)];
}

/**
 * Loudness MOMENTÂNEA (janela de 400 ms, ebur128) a cada 100 ms, opcionalmente
 * depois de um filtro (ex.: passa-banda que isola a trilha).
 */
export async function momentaryLoudness(
  file: string,
  preFilter: string | null,
): Promise<Array<{ t: number; M: number }>> {
  const { stdout } = await ffmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-vn',
    '-af',
    `${preFilter ? `${preFilter},` : ''}ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-`,
    '-f',
    'null',
    '-',
  ]);
  const out: Array<{ t: number; M: number }> = [];
  let t = 0;
  for (const line of stdout.toString().split('\n')) {
    const time = /pts_time:([\d.]+)/.exec(line);
    if (time) t = Number(time[1]);
    const m = /lavfi\.r128\.M=(-?[\d.]+)/.exec(line);
    if (m) out.push({ t: Number(t.toFixed(2)), M: Number(m[1]) });
  }
  return out;
}

/** Média (em LU) das leituras momentâneas cujo instante cai em [a, b]. */
export function meanLoudness(
  series: Array<{ t: number; M: number }>,
  a: number,
  b: number,
): number {
  const picked = series.filter((s) => s.t >= a - 1e-6 && s.t <= b + 1e-6 && s.M > -70);
  if (picked.length === 0) return NaN;
  return picked.reduce((sum, s) => sum + s.M, 0) / picked.length;
}

/** Átomos de topo do MP4, na ordem (`+faststart` ⇒ `moov` antes de `mdat`). */
export async function mp4TopLevelAtoms(file: string): Promise<string[]> {
  const buf = await fs.readFile(file);
  const atoms: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(offset + 8));
    else if (size === 0) size = buf.length - offset;
    atoms.push(type);
    if (size < 8) break;
    offset += size;
  }
  return atoms;
}

/** Índices (em quadros) dos quadros-chave do vídeo. */
export async function keyframeIndexes(file: string): Promise<number[]> {
  const { stdout } = await runBin(FFPROBE, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=flags',
    '-of',
    'csv=p=0',
    file,
  ]);
  return stdout
    .toString()
    .trim()
    .split('\n')
    .map((flags, i) => (flags.includes('K') ? i : -1))
    .filter((i) => i >= 0);
}
