import * as path from 'path';
import { listSourceFiles, stripComments } from './source-files.testutil';

/** Trava contra regressão (design A2): o caminho de uploads só é resolvido por `uploads-dir.ts`. */
const SRC = path.resolve(__dirname, '..', '..');
const CWD_ALLOWED = new Set(['common/config/uploads-dir.ts', 'main.ts', 'worker.ts']);
const UPLOAD_DEST_READ =
  /process\.env\.UPLOAD_DEST\b|\.get\s*(?:<[^>]*>)?\s*\(\s*['"`]UPLOAD_DEST['"`]/g;

/** Leituras de UPLOAD_DEST (código, sem comentários) que não são argumento direto de `resolveUploadsDir(`. */
function findUnresolvedUploadDestReads(text: string): string[] {
  const code = stripComments(text);
  const bad: string[] = [];
  for (const m of code.matchAll(UPLOAD_DEST_READ)) {
    const before = code.slice(0, m.index);
    // `this.config.get(...)` / `this.configService.get(...)`: o argumento do helper começa antes do receptor
    const head = before.replace(/(?:this\.)?\w*[cC]onfig\w*\s*$/, '');
    if (!/resolveUploadsDir\(\s*$/.test(head)) bad.push(m[0]);
  }
  return bad;
}

describe('guarda do diretório de uploads', () => {
  const files = listSourceFiles(SRC, { skipFile: (name) => name.endsWith('.spec.ts') });

  it('process.cwd() só aparece no helper e nos entry points', () => {
    const offenders = files.filter(
      (f) => !CWD_ALLOWED.has(f.rel) && /process\.cwd\(\)/.test(f.text),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  it('toda leitura de UPLOAD_DEST fora do helper é argumento direto de resolveUploadsDir(', () => {
    const offenders = files
      .filter((f) => f.rel !== 'common/config/uploads-dir.ts')
      .filter((f) => findUnresolvedUploadDestReads(f.text).length > 0);
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  describe('findUnresolvedUploadDestReads (a própria trava acusa as formas antigas)', () => {
    it.each([
      [
        'valor guardado em variável e depois unido',
        "const x = this.config.get('UPLOAD_DEST', './uploads');\nconst d = path.join(x, 'a');",
      ],
      [
        'atribuição a propriedade',
        "this.uploadPath = this.configService.get<string>('UPLOAD_DEST') || './uploads';",
      ],
      [
        'join com process.cwd() e process.env',
        "const d = join(process.cwd(), process.env.UPLOAD_DEST || './uploads');",
      ],
      ['path.resolve direto', "path.resolve(this.config.get<string>('UPLOAD_DEST'))"],
      ['resolveUploadsDir só em outro argumento', 'foo(a, process.env.UPLOAD_DEST)'],
    ])('acusa: %s', (_name, text) => {
      expect(findUnresolvedUploadDestReads(text)).toHaveLength(1);
    });

    it.each([
      ['config.get', "resolveUploadsDir(this.config.get<string>('UPLOAD_DEST'))"],
      ['process.env', 'resolveUploadsDir(process.env.UPLOAD_DEST)'],
      ['quebra de linha', "resolveUploadsDir(\n  this.config.get('UPLOAD_DEST'),\n)"],
      ['menção em comentário', '// lê UPLOAD_DEST\n/* process.env.UPLOAD_DEST */'],
      ['menção em texto de log', 'warn(`fora do UPLOAD_DEST: ${p}`)'],
    ])('não acusa: %s', (_name, text) => {
      expect(findUnresolvedUploadDestReads(text)).toHaveLength(0);
    });
  });
});
