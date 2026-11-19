import 'reflect-metadata';

/**
 * Importe este arquivo ANTES de qualquer outro nos comandos de linha (`e2e-seed.cli.ts`, `e2e-flyer-pro-case.cli.ts`):
 * fora do Jest não existe `describe`, e `scene-test-db.ts` (que a lista de entidades e a limpeza das cenas
 * reaproveitam) o lê no topo do arquivo. Um `describe` vazio basta, e o comando não roda spec nenhum.
 */
const globals = globalThis as { describe?: unknown };
globals.describe ??= Object.assign(() => undefined, { skip: () => undefined });
