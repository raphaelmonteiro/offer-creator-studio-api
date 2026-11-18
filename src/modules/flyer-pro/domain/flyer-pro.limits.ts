/** Limites do módulo `flyer-pro`: a página das listas (templates e encartes) e a forma do pedido de criação. */
export const FLYER_PRO_LIMITS = {
  listDefaultLimit: 20,
  listMaxLimit: 50,
  searchMaxLength: 80,
  /** `flyer_pro_documents.name` é `varchar(120)`. */
  nameMaxLength: 120,
  /** Teto das colunas `integer` de `schemaVersion` e `engineVersion` (A-10). */
  versionMax: 2_147_483_647,
} as const;
