import { Injectable } from '@nestjs/common';
import { TAXONOMY_BY_ID, TAXONOMY_CATEGORIES, TaxonomyCategory } from './categories';

@Injectable()
export class TaxonomyService {
  list(): TaxonomyCategory[] {
    return TAXONOMY_CATEGORIES;
  }

  findById(id: number | null | undefined): TaxonomyCategory | null {
    if (id === null || id === undefined) return null;
    return TAXONOMY_BY_ID.get(id) ?? null;
  }

  /**
   * Returns a 0..1 similarity between two category paths based on the longest
   * common prefix. Identical paths return 1; categories sharing only the root
   * return 1/max(depth). Null or unknown ids → 0.
   */
  pathSimilarity(a: number | null, b: number | null): number {
    if (a === null || b === null) return 0;
    if (a === b) return 1;
    const ca = this.findById(a);
    const cb = this.findById(b);
    if (!ca || !cb) return 0;

    let common = 0;
    const max = Math.min(ca.path.length, cb.path.length);
    for (let i = 0; i < max; i++) {
      if (ca.path[i] === cb.path[i]) common += 1;
      else break;
    }
    if (common === 0) return 0;
    return common / Math.max(ca.path.length, cb.path.length);
  }

  /**
   * Compact representation for the LLM prompt: "id|Path > Sub > Leaf".
   * Keeps the prompt under a few KB even with ~120 entries.
   */
  promptList(): string {
    return TAXONOMY_CATEGORIES.map((c) => `${c.id}|${c.path.join(' > ')}`).join('\n');
  }
}
