import { Injectable, Logger } from '@nestjs/common';
import { ProductNameParserService } from '../../metadata/product-name-parser.service';
import { ProductMetadata, QuantityUnit } from '../../metadata/product-metadata.schema';
import { parseFreeTextQuantity } from '../gtin.util';
import type { DotcompanyProduct } from './dotcompany.types';

export const DOTCOMPANY_METADATA_VERSION = 'dotcompany-v1';
export const WARNING_NAME_NOT_VERIFIED = 'dotcompany-nome-nao-verificado';

function quantityFrom(product: DotcompanyProduct): ProductMetadata['quantity'] {
  const fromName = parseFreeTextQuantity(product.nome);
  if (fromName) return { value: fromName.value, unit: fromName.unit as QuantityUnit };
  // Sem quantidade no nome: o peso líquido do catálogo (gramas) ainda serve de pista.
  if (typeof product.peso_liquido === 'number' && product.peso_liquido > 0) {
    return { value: product.peso_liquido, unit: 'g' };
  }
  return null;
}

/**
 * Monta o `ProductMetadata` de uma foto importada da DotCompany SEM visão.
 *
 * O parser de nomes (gpt-4o-mini, em lote) dá categoria da taxonomia,
 * quantidade, embalagem e variante; por cima vão os dados do catálogo — título,
 * marca e o EAN exato (a DotCompany é consultada pelo próprio EAN). Se o parser
 * falhar ou estiver desligado, sai um metadata mínimo determinístico.
 */
@Injectable()
export class DotcompanyMetadataBuilder {
  private readonly logger = new Logger(DotcompanyMetadataBuilder.name);

  constructor(private readonly parser: ProductNameParserService) {}

  async build(
    items: Array<{ ean: string; product: DotcompanyProduct }>,
    verifiedAt: Date,
  ): Promise<ProductMetadata[]> {
    let parsed: (ProductMetadata | null)[] = items.map(() => null);
    try {
      parsed = await this.parser.parseNames(
        items.map(({ product }) => ({
          name: this.parserName(product),
          categoryHint: product.categoria ?? null,
        })),
      );
    } catch (err) {
      this.logger.warn(`Parser de nomes falhou para fotos DotCompany: ${(err as Error).message}`);
    }
    return items.map((item, i) =>
      this.compose(item.ean, item.product, parsed[i] ?? null, verifiedAt),
    );
  }

  private parserName(product: DotcompanyProduct): string {
    const nome = product.nome.trim();
    const marca = product.marca?.trim();
    if (marca && !nome.toLowerCase().includes(marca.toLowerCase())) return `${nome} ${marca}`;
    return nome;
  }

  private compose(
    ean: string,
    product: DotcompanyProduct,
    parsed: ProductMetadata | null,
    verifiedAt: Date,
  ): ProductMetadata {
    const marca = product.marca?.trim() || null;
    const base: ProductMetadata = parsed ?? {
      title: product.nome,
      category: null,
      quantity: null,
      packageType: null,
      pack: null,
      alternatives: [{ brand: null, subBrand: null, variant: null }],
      ean: null,
      sku: null,
      claims: [],
      promo: null,
      dominantColors: [],
      fieldConfidence: {},
      source: 'name-parse',
      modelVersion: DOTCOMPANY_METADATA_VERSION,
      warnings: [],
    };

    const [first, ...rest] = base.alternatives?.length
      ? base.alternatives
      : [{ brand: null, subBrand: null, variant: null }];
    const warnings = [...(base.warnings ?? [])];
    if (product.nome_verificado === false && !warnings.includes(WARNING_NAME_NOT_VERIFIED)) {
      warnings.push(WARNING_NAME_NOT_VERIFIED);
    }

    return {
      ...base,
      title: product.nome.trim(),
      quantity: base.quantity ?? quantityFrom(product),
      alternatives: [{ ...first, brand: marca ?? first.brand }, ...rest],
      ean,
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
      eanConfidence: 1,
      eanVerifiedAt: verifiedAt.toISOString(),
      eanStatus: 'resolved',
      fieldConfidence: {
        ...(base.fieldConfidence ?? {}),
        title: 1,
        ean: 1,
        ...(marca ? { brand: 1 } : {}),
      },
      source: 'name-parse',
      modelVersion: parsed
        ? `${DOTCOMPANY_METADATA_VERSION}+${base.modelVersion}`
        : DOTCOMPANY_METADATA_VERSION,
      warnings,
    };
  }
}
