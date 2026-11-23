import { candidateLimit, ScoredCandidateV2 } from '../../metadata/product-image-match-v2.service';

/**
 * Junta os grupos de candidatas na ordem em que chegam (EAN, nome já escolhido, busca por nome) sem repetir foto: a
 * foto que aparece em mais de um grupo fica na posição do primeiro e soma os motivos dos outros. Corta no `limit` da
 * rota (de 1 a 24).
 */
export function mergeCandidates(groups: ScoredCandidateV2[][], limit: number): ScoredCandidateV2[] {
  const byId = new Map<string, ScoredCandidateV2>();
  for (const candidate of groups.flat()) {
    const known = byId.get(candidate.imageId);
    if (!known) {
      byId.set(candidate.imageId, { ...candidate });
      continue;
    }
    known.reasons = [...new Set([...known.reasons, ...candidate.reasons])];
  }
  return [...byId.values()].slice(0, candidateLimit(limit));
}
