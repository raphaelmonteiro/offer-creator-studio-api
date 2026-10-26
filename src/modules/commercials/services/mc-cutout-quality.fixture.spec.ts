import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import {
  ffmpeg,
  FFMPEG_FIXTURES_ENABLED,
  imageClip,
  probe,
} from '../domain/__fixtures__/mc-ffmpeg-fixture.helpers';
import { McCutoutQualityService } from './mc-cutout-quality.service';

/**
 * Fixture com FFmpeg REAL da verificação do recorte (video-mascote-transparente, 1.8): um clipe
 * estável (figura sobre #00B140 constante) aprova e um clipe de fundo instável (o tom do fundo muda
 * no meio, a fixture do provider mock) reprova. Roda SOMENTE com `MC_TEST_FFMPEG=1`.
 */
const describeIf = FFMPEG_FIXTURES_ENABLED ? describe : describe.skip;

const figureSvg = (background: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1440">' +
  `<rect width="100%" height="100%" fill="${background}"/>` +
  '<circle cx="360" cy="320" r="180" fill="#E0A070"/>' +
  '<rect x="270" y="500" width="180" height="520" fill="#2255CC"/>' +
  '<rect x="270" y="1020" width="70" height="330" fill="#1A2F7A"/>' +
  '<rect x="380" y="1020" width="70" height="330" fill="#1A2F7A"/>' +
  '<rect x="450" y="640" width="150" height="50" fill="#E0A070"/>' +
  '<rect x="540" y="690" width="120" height="100" fill="#8B4513"/>' +
  '</svg>';

describeIf('McCutoutQualityService com ffmpeg real (MC_TEST_FFMPEG=1)', () => {
  let dir: string;
  let service: McCutoutQualityService;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cutout-quality-'));
    const runner = {
      run: (args: string[]) => ffmpeg(args).then(() => undefined),
    } as unknown as FfmpegRunner;
    service = new McCutoutQualityService(runner);
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function clip(name: string, backgrounds: string[]): Promise<string> {
    const parts: string[] = [];
    for (let i = 0; i < backgrounds.length; i += 1) {
      const png = path.join(dir, `${name}-${i}.png`);
      await sharp(Buffer.from(figureSvg(backgrounds[i])))
        .png()
        .toFile(png);
      const mp4 = path.join(dir, `${name}-${i}.mp4`);
      await imageClip(mp4, png, 1.0);
      parts.push(mp4);
    }
    if (parts.length === 1) return parts[0];
    const out = path.join(dir, `${name}.mp4`);
    const list = path.join(dir, `${name}.txt`);
    await fs.writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
    await ffmpeg([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      out,
    ]);
    return out;
  }

  it('clipe estável: aprova (fundo na cor-chave, sem resto, sem halo)', async () => {
    const file = await clip('stable', ['#00B140']);
    const durationMs = (await probe(file)).durationMs as number;
    const report = await service.verifyClips({
      clips: [{ sceneId: 's1', idx: 0, path: file, durationMs }],
      keyColor: '#00B140',
      tempDir: dir,
    });
    // eslint-disable-next-line no-console
    console.log(`[cutout quality] estável ${JSON.stringify(report.scenes[0])}`);
    expect(report.scenes[0].reasons).toEqual([]);
    expect(report.passed).toBe(true);
  }, 120_000);

  it('clipe de fundo instável (o tom muda no meio): reprova com background_unstable', async () => {
    const file = await clip('unstable', ['#00B140', '#30D078']);
    const durationMs = (await probe(file)).durationMs as number;
    const report = await service.verifyClips({
      clips: [{ sceneId: 's1', idx: 0, path: file, durationMs }],
      keyColor: '#00B140',
      tempDir: dir,
    });
    // eslint-disable-next-line no-console
    console.log(`[cutout quality] instável ${JSON.stringify(report.scenes[0])}`);
    expect(report.passed).toBe(false);
    expect(report.scenes[0].reasons).toContain('background_unstable');
  }, 120_000);
});
