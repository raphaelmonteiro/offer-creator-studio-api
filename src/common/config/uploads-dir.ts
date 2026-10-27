import * as path from 'path';

/**
 * Diretório de trabalho do processo no momento em que este módulo é carregado
 * (antes de qualquer job e antes de qualquer chdir). `@remotion/bundler` troca
 * o cwd durante o `bundle()`, então caminho relativo resolvido "a cada uso"
 * cai na pasta do Remotion. Toda resolução de UPLOAD_DEST passa por aqui.
 */
const BOOT_CWD: string = process.cwd();

export function bootCwd(): string {
  return BOOT_CWD;
}

/** Ancora o valor configurado (relativo ou absoluto) no diretório do boot. */
export function resolveUploadsDir(configured?: string | null): string {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return path.resolve(BOOT_CWD, value || './uploads');
}

/** Ancora um caminho de aplicação (ex.: MC_VIDEO_TEMPLATES_DIR) no diretório do boot. */
export function resolveAppPath(p: string): string {
  return path.resolve(BOOT_CWD, p);
}

/** Normaliza `env.UPLOAD_DEST` para o absoluto; idempotente. */
export function pinUploadsDirEnv(env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveUploadsDir(env.UPLOAD_DEST);
  env.UPLOAD_DEST = resolved;
  return resolved;
}
