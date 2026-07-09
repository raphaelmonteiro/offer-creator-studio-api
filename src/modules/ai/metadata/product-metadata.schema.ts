import { z } from 'zod';

export const QuantityUnitSchema = z.enum(['g', 'kg', 'ml', 'l', 'un', 'm']);
export type QuantityUnit = z.infer<typeof QuantityUnitSchema>;

export const PackageTypeSchema = z.enum([
  'garrafa',
  'lata',
  'pote',
  'sache',
  'caixa',
  'fardo',
  'pacote',
  'bandeja',
  'tubo',
  'frasco',
  'rolo',
  'unidade',
  'desconhecido',
]);
export type PackageType = z.infer<typeof PackageTypeSchema>;

export const CategorySchema = z.object({
  id: z.number().int().nonnegative(),
  path: z.array(z.string().min(1)).min(1),
});

export const QuantitySchema = z.object({
  value: z.number().positive(),
  unit: QuantityUnitSchema,
});

export const PackSchema = z.object({
  count: z.number().int().positive(),
  promoCount: z.number().int().positive().optional(),
});

export const AlternativeSchema = z.object({
  brand: z.string().min(1).nullable(),
  subBrand: z.string().min(1).nullable(),
  variant: z.string().min(1).nullable(),
});
export type Alternative = z.infer<typeof AlternativeSchema>;

export const FieldConfidenceSchema = z.record(z.string(), z.number().min(0).max(1));

export const SourceSchema = z.enum(['vision', 'name-parse']);
export type MetadataSource = z.infer<typeof SourceSchema>;

export const ProductMetadataSchema = z.object({
  title: z.string().min(1),
  category: CategorySchema.nullable(),
  quantity: QuantitySchema.nullable(),
  packageType: PackageTypeSchema.nullable(),
  pack: PackSchema.nullable(),
  alternatives: z.array(AlternativeSchema).min(1),
  ean: z
    .string()
    .regex(/^\d{8}$|^\d{12,14}$/)
    .nullable(),
  sku: z.string().min(1).nullable(),
  claims: z.array(z.string().min(1)),
  promo: z.string().min(1).nullable(),
  dominantColors: z.array(z.string().min(1)),
  fieldConfidence: FieldConfidenceSchema,
  source: SourceSchema,
  modelVersion: z.string().min(1),
  warnings: z.array(z.string().min(1)),
});
export type ProductMetadata = z.infer<typeof ProductMetadataSchema>;

const isoString = (input: string | null | undefined): string => (input ?? '').toString().trim();

/**
 * Builds the canonical text fed into text-embedding-3-small to populate the
 * `metadata_embedding` vector. We pick the highest-signal fields and keep the
 * format stable so embeddings remain comparable across image and parsed-name
 * sources.
 */
export function buildEmbeddingText(metadata: ProductMetadata): string {
  const parts: string[] = [isoString(metadata.title)];

  const primaryAlt = metadata.alternatives[0];
  if (primaryAlt) {
    if (primaryAlt.brand) parts.push(primaryAlt.brand);
    if (primaryAlt.subBrand) parts.push(primaryAlt.subBrand);
    if (primaryAlt.variant) parts.push(primaryAlt.variant);
  }

  if (metadata.category) {
    parts.push(metadata.category.path.join(' > '));
  }

  if (metadata.quantity) {
    parts.push(`${metadata.quantity.value}${metadata.quantity.unit}`);
  }

  if (metadata.packageType && metadata.packageType !== 'desconhecido') {
    parts.push(metadata.packageType);
  }

  return parts.filter((p) => p && p.length > 0).join(' | ');
}

/**
 * Lossy parse used right after the LLM returns: if the payload is *partially*
 * valid we keep the good fields and drop the bad ones rather than rejecting
 * the entire object. Returns null if the payload has no salvageable shape.
 */
export function parseMetadataLenient(
  raw: unknown,
  fallback: { source: MetadataSource; modelVersion: string },
): ProductMetadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : null;
  if (!title) return null;

  const safeArray = <T>(value: unknown, schema: z.ZodType<T>): T[] => {
    if (!Array.isArray(value)) return [];
    const out: T[] = [];
    for (const item of value) {
      const parsed = schema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  };

  const alternatives = safeArray(r.alternatives, AlternativeSchema);
  if (alternatives.length === 0) {
    alternatives.push({ brand: null, subBrand: null, variant: null });
  }

  const category = CategorySchema.safeParse(r.category);
  const quantity = QuantitySchema.safeParse(r.quantity);
  const pack = PackSchema.safeParse(r.pack);
  const packageType = PackageTypeSchema.safeParse(r.packageType);

  const ean = typeof r.ean === 'string' && /^\d{8}$|^\d{12,14}$/.test(r.ean) ? r.ean : null;
  const sku = typeof r.sku === 'string' && r.sku.trim() ? r.sku.trim() : null;

  const claims = Array.isArray(r.claims)
    ? r.claims.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  const dominantColors = Array.isArray(r.dominantColors)
    ? r.dominantColors.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  const warnings = Array.isArray(r.warnings)
    ? r.warnings.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];

  const fieldConfidence: Record<string, number> = {};
  if (r.fieldConfidence && typeof r.fieldConfidence === 'object') {
    for (const [key, value] of Object.entries(r.fieldConfidence)) {
      if (typeof value === 'number' && value >= 0 && value <= 1) {
        fieldConfidence[key] = value;
      }
    }
  }

  return {
    title,
    category: category.success ? category.data : null,
    quantity: quantity.success ? quantity.data : null,
    packageType: packageType.success ? packageType.data : null,
    pack: pack.success ? pack.data : null,
    alternatives,
    ean,
    sku,
    claims,
    promo: typeof r.promo === 'string' && r.promo.trim() ? r.promo.trim() : null,
    dominantColors,
    fieldConfidence,
    source: fallback.source,
    modelVersion: fallback.modelVersion,
    warnings,
  };
}

export function averageConfidence(metadata: ProductMetadata): number {
  const values = Object.values(metadata.fieldConfidence).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
