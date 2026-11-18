import type { FlyerProFieldIssue } from './flyer-pro.errors';
import { isSent } from './flyer-pro-presence';
import type { ExportFormat, ExportPreset, FlyerProExportEntry } from './flyer-pro.types';

/**
 * As regras de negócio do registro de uma exportação (N8, 422), puras. O servidor confere só a coerência do que o pedido
 * diz de si mesmo (preset, extensão) e a revisão; folhas contra o encarte, pixels, `jpegQuality`, `bleed`,
 * `engineVersion` e `preflight` não têm regra, porque o registro pode chegar depois de o encarte mudar (A-13).
 */

/** O que cada preset exige: o formato, o DPI e, quando a opção é "uma folha", exatamente uma folha. */
const PRESET_RULES: Record<ExportPreset, { format: ExportFormat; dpi: number; oneSheet: boolean }> =
  {
    'png-450-sheet': { format: 'png', dpi: 450, oneSheet: true },
    'pdf-450-all': { format: 'pdf', dpi: 450, oneSheet: false },
    'zip-450-all': { format: 'zip', dpi: 450, oneSheet: false },
    'png-72-sheet': { format: 'png', dpi: 72, oneSheet: true },
  };

/** `null` em `fileSize`, `preflight` e `options.jpegQuality` vale como ausente (D-3): sai sem a chave. */
export function normalizeExportEntry(entry: FlyerProExportEntry): FlyerProExportEntry {
  const { fileSize, preflight, options, ...rest } = entry;
  const { jpegQuality, ...otherOptions } = options;
  return {
    ...rest,
    options: isSent(jpegQuality) ? options : otherOptions,
    ...(isSent(fileSize) ? { fileSize } : {}),
    ...(isSent(preflight) ? { preflight } : {}),
  };
}

/** Cada campo do pedido que o preset não aceita vira um `PRESET_MISMATCH`, na ordem `format`, `options.dpi`, `options.sheets`. */
function presetIssues({ format, options }: FlyerProExportEntry): FlyerProFieldIssue[] {
  const rule = PRESET_RULES[options.preset];
  const issues: FlyerProFieldIssue[] = [];
  if (format !== rule.format) issues.push({ field: 'format', code: 'PRESET_MISMATCH' });
  if (options.dpi !== rule.dpi) issues.push({ field: 'options.dpi', code: 'PRESET_MISMATCH' });
  if (rule.oneSheet && options.sheets.length !== 1) {
    issues.push({ field: 'options.sheets', code: 'PRESET_MISMATCH' });
  }
  return issues;
}

/** A extensão de `fileName` (depois do último ponto) tem de ser o `format`. */
const extensionOf = (fileName: string): string => fileName.slice(fileName.lastIndexOf('.') + 1);

/**
 * Os problemas de regra do registro, todos de uma vez e nesta ordem: `PRESET_MISMATCH` (`format`, `options.dpi`,
 * `options.sheets`), `FILE_NAME_EXTENSION` e `REVISION_AHEAD`. `currentRevision` é a revisão do encarte vivo: revisão
 * igual ou menor passa (o registro pode chegar depois de o encarte mudar), maior não.
 */
export function exportIssues(
  entry: FlyerProExportEntry,
  currentRevision: number,
): FlyerProFieldIssue[] {
  const issues = presetIssues(entry);
  if (extensionOf(entry.fileName) !== entry.format) {
    issues.push({ field: 'fileName', code: 'FILE_NAME_EXTENSION' });
  }
  if (entry.documentRevision > currentRevision) {
    issues.push({ field: 'documentRevision', code: 'REVISION_AHEAD' });
  }
  return issues;
}
