/** Limites do módulo `flyer-pro`: a página das listas, a forma dos pedidos e os tamanhos do salvar (em bytes do JSON). */
export const FLYER_PRO_LIMITS = {
  listDefaultLimit: 20,
  listMaxLimit: 50,
  searchMaxLength: 80,
  /** `flyer_pro_documents.name` é `varchar(120)`. */
  nameMaxLength: 120,
  /** Teto das colunas `integer` de `schemaVersion`, `engineVersion`, `position` e do tamanho da foto (A-5, A-10). */
  versionMax: 2_147_483_647,
  /** Cada fatia do encarte (`frame`, `structure`, `card`, `assembly`, `exportPrefs`): 256 KB (A-3). */
  sliceMaxBytes: 262_144,
  /** O `layoutSnapshot`: 128 KB. */
  layoutSnapshotMaxBytes: 131_072,
  /** O corpo inteiro do `PATCH`: 2 MB. */
  patchMaxBytes: 2_097_152,
  /** O estado de tela (`ui`) do cursor: 16 KB. */
  uiMaxBytes: 16_384,
  /** Itens por encarte, e entradas de `items.upsert` e `items.delete` num `PATCH`. */
  itemMax: 500,
  /** O `imported` de um item: 2 KB. */
  importedMaxBytes: 2_048,
  /** `flyer_pro_items.name` e o motivo de uma decisão de categoria. */
  itemNameMaxLength: 120,
  /** `flyer_pro_items.sourceName`. */
  sourceNameMaxLength: 255,
  /** `flyer_pro_items.imageUrl`. */
  imageUrlMaxLength: 1_000,
  /** Valor em centavos de um preço: de 1 a 9 999 999 (as regras do protótipo, A-9). */
  priceMaxCents: 9_999_999,
  /** O motivo do bloqueio de uma sugestão de categoria. */
  decisionReasonMaxLength: 120,
  /** Linhas recusadas que o registro de uma importação guarda (`flyer_pro_imports.rejected`). */
  importRejectedMax: 200,
  /** O trecho `raw` de uma linha recusada. */
  importRawMaxLength: 200,
  /** `flyer_pro_imports.fileName`. */
  importFileNameMaxLength: 255,
  /** `flyer_pro_imports.fileHash`. */
  importFileHashMaxLength: 64,
  /** `flyer_pro_imports.detectedFormat`. */
  importDetectedFormatMaxLength: 16,
} as const;
