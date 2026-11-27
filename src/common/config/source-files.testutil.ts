import * as fs from 'fs';
import * as path from 'path';

/** Arquivo `.ts` lido do disco: `rel` é o caminho relativo a `root`, com `/`. */
export interface SourceFile {
  rel: string;
  text: string;
}

export interface ListSourceFilesOptions {
  /** Pasta a partir da qual `rel` é medido (padrão: o próprio `dir`). */
  root?: string;
  /** Nomes de pasta que o caminhar não abre. */
  skipDirs?: ReadonlySet<string>;
  /** Recusa um arquivo `.ts` pelo nome (padrão: aceita todos). */
  skipFile?: (fileName: string) => boolean;
}

/** Os `.ts` sob `dir` (recursivo), com o texto de cada um; cada guarda aplica o seu filtro por `options`. */
export function listSourceFiles(dir: string, options: ListSourceFilesOptions = {}): SourceFile[] {
  const root = options.root ?? dir;
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return options.skipDirs?.has(entry.name) ? [] : listSourceFiles(full, { ...options, root });
    }
    if (!entry.name.endsWith('.ts') || options.skipFile?.(entry.name)) return [];
    const rel = path.relative(root, full).split(path.sep).join('/');
    return [{ rel, text: fs.readFileSync(full, 'utf8') }];
  });
}

/** O código sem comentários de bloco e de linha (o `//` de uma URL `https://` fica). */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
