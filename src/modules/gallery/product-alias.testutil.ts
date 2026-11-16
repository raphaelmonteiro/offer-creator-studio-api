/** Apoio dos testes dos nomes escolhidos da foto (`metadata.aliases`). */

import { PRODUCT_ALIAS_MAX, ProductAlias } from './product-alias';

/** Uma entrada de nome escolhido; sem `name`, o nome é a própria chave. */
export function aliasAt(key: string, chosenAt: string, name = key): ProductAlias {
  return { name, key, chosenAt };
}

/** `PRODUCT_ALIAS_MAX` nomes (`<prefix> 0`, `<prefix> 1`...) com datas crescentes: o índice 0 é o mais antigo. */
export function aliasesAtMax(prefix: string): ProductAlias[] {
  return Array.from({ length: PRODUCT_ALIAS_MAX }, (_, i) =>
    aliasAt(`${prefix} ${i}`, `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z`),
  );
}
