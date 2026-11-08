import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Escrita atomica: cria a pasta, grava em arquivo temporario e renomeia, para nunca ficar meio arquivo servido.
 * `write` recebe o caminho do temporario (buffer ou copia por stream).
 */
export async function writeFileAtomic(
  absolute: string,
  write: (temp: string) => Promise<void>,
): Promise<void> {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.${randomUUID()}.tmp`;
  try {
    await write(temp);
    await fs.rename(temp, absolute);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
