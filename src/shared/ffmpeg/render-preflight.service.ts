import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  RenderPreflight,
  RenderRequirementCheck,
  RenderRequirementId,
  summarizeRenderPreflight,
} from './render-preflight';

/** Caminhos usuais da DejaVu Sans (Alpine, Debian/Ubuntu, Fedora, Arch, macOS). */
export const DEJAVU_FONT_CANDIDATES = [
  '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/Library/Fonts/DejaVuSans.ttf',
  `${homedir()}/Library/Fonts/DejaVuSans.ttf`,
];

const EXEC_TIMEOUT_MS = 10_000;

/**
 * Executa as checagens de ambiente do render no processo worker (design D14):
 * ffmpeg e ffprobe (binários de FFMPEG_PATH/FFPROBE_PATH), a fonte DejaVu que
 * o `drawtext` usa (MC_RENDER_FONT_FILE ou os caminhos usuais, ou `fc-list`) e
 * o navegador de render (MC_RENDER_BROWSER), que só bloqueia `offer_carousel`.
 * Nunca lança: cada checagem vira `ok: false` com o motivo.
 */
@Injectable()
export class RenderPreflightService {
  private readonly logger = new Logger(RenderPreflightService.name);

  constructor(private readonly config: ConfigService) {}

  async run(now: Date = new Date()): Promise<RenderPreflight> {
    const checks = await Promise.all([
      this.checkBinary('ffmpeg', this.config.get<string>('FFMPEG_PATH', 'ffmpeg')),
      this.checkBinary('ffprobe', this.config.get<string>('FFPROBE_PATH', 'ffprobe')),
      this.checkFonts(),
      this.checkBrowser(),
    ]);
    const preflight = summarizeRenderPreflight(checks, now.toISOString());
    const missing = checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.detail ?? 'faltando'})`);
    if (missing.length > 0) {
      this.logger.warn(`Preflight de render com pendências: ${missing.join('; ')}`);
    } else {
      this.logger.log('Preflight de render: tudo presente');
    }
    return preflight;
  }

  private async checkBinary(id: RenderRequirementId, bin: string): Promise<RenderRequirementCheck> {
    try {
      const out = await this.exec(bin, ['-version']);
      const firstLine = out.split('\n')[0]?.trim() ?? '';
      const version = firstLine.match(/version\s+(\S+)/i)?.[1] ?? firstLine;
      return { id, ok: true, version: version || bin };
    } catch (err) {
      return { id, ok: false, version: null, detail: `${bin}: ${this.describe(err)}` };
    }
  }

  private async checkFonts(): Promise<RenderRequirementCheck> {
    const configured = this.config.get<string>('MC_RENDER_FONT_FILE');
    const candidates = configured
      ? [configured, ...DEJAVU_FONT_CANDIDATES]
      : DEJAVU_FONT_CANDIDATES;
    for (const file of candidates) {
      if (await this.exists(file)) return { id: 'fonts', ok: true, version: file };
    }
    try {
      const list = await this.exec('fc-list', [':', 'family']);
      if (/dejavu/i.test(list)) return { id: 'fonts', ok: true, version: 'fc-list: DejaVu' };
    } catch {
      // sem fontconfig: cai no "não encontrada" abaixo
    }
    return {
      id: 'fonts',
      ok: false,
      version: null,
      detail: `DejaVu Sans não encontrada (MC_RENDER_FONT_FILE ou ${DEJAVU_FONT_CANDIDATES.slice(0, 2).join(', ')}…)`,
    };
  }

  private async checkBrowser(): Promise<RenderRequirementCheck> {
    const bin = this.config.get<string>('MC_RENDER_BROWSER');
    if (!bin) {
      return {
        id: 'browser',
        ok: false,
        version: null,
        detail: 'MC_RENDER_BROWSER não definido (necessário só para ofertas em sequência)',
      };
    }
    if (!(await this.exists(bin, constants.X_OK))) {
      return { id: 'browser', ok: false, version: null, detail: `${bin}: não executável` };
    }
    try {
      const out = await this.exec(bin, ['--version']);
      return { id: 'browser', ok: true, version: out.split('\n')[0]?.trim() || bin };
    } catch {
      // alguns binários não respondem a --version num ambiente headless; o executável existir basta
      return { id: 'browser', ok: true, version: bin };
    }
  }

  private exec(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve(`${stdout ?? ''}${stderr ?? ''}`);
      });
    });
  }

  private async exists(file: string, mode: number = constants.R_OK): Promise<boolean> {
    try {
      await access(file, mode);
      return true;
    } catch {
      return false;
    }
  }

  private describe(err: unknown): string {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') return 'não encontrado';
    return e?.message ?? String(err);
  }
}
