import * as fs from 'fs';
import * as path from 'path';
import { OUT_ROOT } from './config';

/** Verificações do `selftest` (dry-run): imprime PASS/FAIL e conta as falhas. */
export class Drill {
  failures = 0;
  total = 0;

  check(name: string, ok: boolean, detail = ''): void {
    this.total += 1;
    if (!ok) this.failures += 1;
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}\n`);
  }

  async rejects(
    name: string,
    fn: () => unknown,
    match: RegExp | ((e: Error) => boolean),
  ): Promise<void> {
    try {
      await fn();
      this.check(name, false, 'não lançou');
    } catch (e) {
      const err = e as Error;
      const ok = typeof match === 'function' ? match(err) : match.test(err.message);
      this.check(name, ok, ok ? '' : err.message);
    }
  }

  section(title: string): void {
    process.stdout.write(`\n${title}\n`);
  }
}

/** Pasta descartável do selftest, sempre dentro de `scripts/out/` (ignorada pelo git e pelo Docker). */
export function drillDir(name: string): string {
  const dir = path.join(OUT_ROOT, '_selftest', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
