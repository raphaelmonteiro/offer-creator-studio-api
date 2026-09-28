import type { ProductMetadata } from '../metadata/product-metadata.schema';
import type { EanCandidateRecord } from './ean-match.types';
import type { ImagemGaleria } from './ean-candidate.service';
import { Gs1PrefixMap } from './gs1-prefix-map';
import { canonicalQuantity, parseFreeTextQuantity, quantityMatches } from './gtin.util';
import { variantGate } from './variant-token.util';

/**
 * Vetos determinísticos, aplicados ANTES de qualquer IA. Só contradições
 * objetivas vetam; ausência de informação nunca veta (a foto "Ype.png" sem
 * variante ainda vai para o juiz, que lê o rótulo).
 *
 * Marca cada candidata com o motivo e devolve as sobreviventes, na ordem.
 */
export function aplicarVetos(
  descricao: string,
  ean: string,
  candidatas: EanCandidateRecord[],
  imagens: Map<string, ImagemGaleria>,
  prefixos: Gs1PrefixMap,
): EanCandidateRecord[] {
  const qtdLinha = parseFreeTextQuantity(descricao);

  for (const c of candidatas) {
    const img = imagens.get(c.imageId);
    const metadata: ProductMetadata | undefined = img?.metadata;

    const qtdImg = canonicalQuantity(metadata?.quantity ?? null);
    if (qtdLinha && qtdImg && !quantityMatches(qtdLinha, qtdImg)) {
      c.vetoes.push({
        reason: 'quantity',
        detail: `planilha ${qtdLinha.value}${qtdLinha.unit} × imagem ${qtdImg.value}${qtdImg.unit}`,
      });
    }

    if (img) {
      const gate = variantGate(descricao, img.texto);
      if (gate.reason === 'conflito-de-variante') {
        c.vetoes.push({ reason: 'variant', detail: `grupo ${gate.conflictingGroup}` });
      }
    }

    const gs1 = prefixos.veto(ean, c.brand);
    if (gs1) c.vetoes.push({ reason: 'gs1-prefix', detail: gs1 });
  }

  return candidatas.filter((c) => c.vetoes.length === 0);
}
