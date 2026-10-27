import * as fs from 'fs';
import * as path from 'path';

/** Trava contra regressão (design A2): o caminho de uploads só é resolvido por `uploads-dir.ts`. */
const SRC = path.resolve(__dirname, '..', '..');
const CWD_ALLOWED = new Set(['common/config/uploads-dir.ts', 'main.ts', 'worker.ts']);
const UPLOAD_RESOLVE_EXCEPTIONS = new Set<string>([]);

function listSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('guarda do diretório de uploads', () => {
  const files = listSources(SRC).map((f) => ({
    rel: path.relative(SRC, f).split(path.sep).join('/'),
    text: fs.readFileSync(f, 'utf8'),
  }));

  it('process.cwd() só aparece no helper e nos entry points', () => {
    const offenders = files.filter(
      (f) => !CWD_ALLOWED.has(f.rel) && /process\.cwd\(\)/.test(f.text),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  it('UPLOAD_DEST não é combinado com path.resolve/join fora do helper', () => {
    const offenders = files.filter(
      (f) =>
        f.rel !== 'common/config/uploads-dir.ts' &&
        !UPLOAD_RESOLVE_EXCEPTIONS.has(f.rel) &&
        /(path\.)?(resolve|join)\(\s*(this\.)?(config|configService)\.get[^)]*UPLOAD_DEST|(resolve|join)\(process\.env\.UPLOAD_DEST/.test(
          f.text,
        ),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});
