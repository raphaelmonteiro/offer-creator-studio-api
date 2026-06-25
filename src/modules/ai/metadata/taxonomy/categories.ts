/**
 * Compact category list curated for Brazilian supermarket/varejista catalogs.
 * Loosely derived from Google Product Taxonomy pt-BR, kept small (~80 entries)
 * so the entire list fits in the LLM prompt without truncation. Categories the
 * LLM needs outside this list should be added here over time.
 *
 * The `id` is stable: never renumber an existing category — only append.
 */
export interface TaxonomyCategory {
  id: number;
  path: string[];
}

export const TAXONOMY_CATEGORIES: TaxonomyCategory[] = [
  // Mercearia — básicos
  { id: 101, path: ['Mercearia', 'Arroz'] },
  { id: 102, path: ['Mercearia', 'Feijão'] },
  { id: 103, path: ['Mercearia', 'Açúcar e adoçantes'] },
  { id: 104, path: ['Mercearia', 'Sal e temperos'] },
  { id: 105, path: ['Mercearia', 'Farinhas'] },
  { id: 106, path: ['Mercearia', 'Macarrão e massas'] },
  { id: 107, path: ['Mercearia', 'Macarrão instantâneo'] },
  { id: 108, path: ['Mercearia', 'Óleos e azeites'] },
  { id: 109, path: ['Mercearia', 'Vinagres'] },
  { id: 110, path: ['Mercearia', 'Molhos e condimentos'] },
  { id: 111, path: ['Mercearia', 'Extrato e molho de tomate'] },
  { id: 112, path: ['Mercearia', 'Maionese'] },
  { id: 113, path: ['Mercearia', 'Mostarda e ketchup'] },
  { id: 114, path: ['Mercearia', 'Enlatados e conservas'] },
  { id: 115, path: ['Mercearia', 'Atum e sardinha'] },
  { id: 116, path: ['Mercearia', 'Milho e ervilha em conserva'] },
  { id: 117, path: ['Mercearia', 'Farofa e tempero pronto'] },
  { id: 118, path: ['Mercearia', 'Café'] },
  { id: 119, path: ['Mercearia', 'Achocolatado em pó'] },
  { id: 120, path: ['Mercearia', 'Chás e mate'] },
  { id: 121, path: ['Mercearia', 'Leite condensado e creme de leite'] },
  { id: 122, path: ['Mercearia', 'Cereais matinais e granola'] },
  { id: 123, path: ['Mercearia', 'Geleias e doces de pote'] },
  { id: 124, path: ['Mercearia', 'Pó para gelatina e pudim'] },
  { id: 125, path: ['Mercearia', 'Mel e melado'] },

  // Biscoitos e snacks
  { id: 140, path: ['Biscoitos e snacks', 'Biscoito recheado'] },
  { id: 141, path: ['Biscoitos e snacks', 'Biscoito amanteigado e rosquinha'] },
  { id: 142, path: ['Biscoitos e snacks', 'Biscoito wafer'] },
  { id: 143, path: ['Biscoitos e snacks', 'Biscoito salgado e cream cracker'] },
  { id: 144, path: ['Biscoitos e snacks', 'Salgadinhos de pacote'] },
  { id: 145, path: ['Biscoitos e snacks', 'Batata frita em pacote'] },
  { id: 146, path: ['Biscoitos e snacks', 'Amendoim e castanhas'] },
  { id: 147, path: ['Biscoitos e snacks', 'Bolos e mini bolos industrializados'] },
  { id: 148, path: ['Biscoitos e snacks', 'Chocolates e barras'] },
  { id: 149, path: ['Biscoitos e snacks', 'Balas e gomas'] },

  // Bebidas
  { id: 160, path: ['Bebidas', 'Água mineral'] },
  { id: 161, path: ['Bebidas', 'Refrigerantes'] },
  { id: 162, path: ['Bebidas', 'Sucos prontos'] },
  { id: 163, path: ['Bebidas', 'Suco em pó'] },
  { id: 164, path: ['Bebidas', 'Energéticos'] },
  { id: 165, path: ['Bebidas', 'Isotônicos'] },
  { id: 166, path: ['Bebidas', 'Cervejas'] },
  { id: 167, path: ['Bebidas', 'Vinhos'] },
  { id: 168, path: ['Bebidas', 'Destilados e licores'] },
  { id: 169, path: ['Bebidas', 'Águas saborizadas e tônicas'] },

  // Frios e laticínios refrigerados
  { id: 180, path: ['Frios e refrigerados', 'Leite UHT'] },
  { id: 181, path: ['Frios e refrigerados', 'Leite em pó'] },
  { id: 182, path: ['Frios e refrigerados', 'Iogurte'] },
  { id: 183, path: ['Frios e refrigerados', 'Manteiga e margarina'] },
  { id: 184, path: ['Frios e refrigerados', 'Queijo mussarela e prato'] },
  { id: 185, path: ['Frios e refrigerados', 'Queijo ralado'] },
  { id: 186, path: ['Frios e refrigerados', 'Presunto e apresuntado'] },
  { id: 187, path: ['Frios e refrigerados', 'Mortadela e salame'] },
  { id: 188, path: ['Frios e refrigerados', 'Linguiça'] },
  { id: 189, path: ['Frios e refrigerados', 'Salsicha'] },
  { id: 190, path: ['Frios e refrigerados', 'Bacon'] },
  { id: 191, path: ['Frios e refrigerados', 'Requeijão e cream cheese'] },

  // Congelados
  { id: 200, path: ['Congelados', 'Hambúrguer congelado'] },
  { id: 201, path: ['Congelados', 'Empanados de frango'] },
  { id: 202, path: ['Congelados', 'Batata congelada'] },
  { id: 203, path: ['Congelados', 'Pizza congelada'] },
  { id: 204, path: ['Congelados', 'Lasanha e pratos prontos'] },
  { id: 205, path: ['Congelados', 'Peixes congelados'] },
  { id: 206, path: ['Congelados', 'Sorvetes e açaí'] },
  { id: 207, path: ['Congelados', 'Pão de queijo congelado'] },

  // Açougue
  { id: 220, path: ['Açougue', 'Carne bovina'] },
  { id: 221, path: ['Açougue', 'Carne suína'] },
  { id: 222, path: ['Açougue', 'Frango'] },
  { id: 223, path: ['Açougue', 'Miúdos e vísceras'] },
  { id: 224, path: ['Açougue', 'Carnes salgadas e secas'] },

  // Hortifruti
  { id: 240, path: ['Hortifruti', 'Frutas'] },
  { id: 241, path: ['Hortifruti', 'Verduras e folhas'] },
  { id: 242, path: ['Hortifruti', 'Legumes'] },
  { id: 243, path: ['Hortifruti', 'Tubérculos'] },
  { id: 244, path: ['Hortifruti', 'Temperos frescos'] },
  { id: 245, path: ['Hortifruti', 'Ovos'] },

  // Padaria
  { id: 260, path: ['Padaria', 'Pão francês e similares'] },
  { id: 261, path: ['Padaria', 'Pão de forma'] },
  { id: 262, path: ['Padaria', 'Pão integral e especiais'] },
  { id: 263, path: ['Padaria', 'Bolos e tortas'] },
  { id: 264, path: ['Padaria', 'Doces e sonhos'] },
  { id: 265, path: ['Padaria', 'Salgados assados'] },

  // Limpeza
  { id: 280, path: ['Limpeza', 'Sabão em pó'] },
  { id: 281, path: ['Limpeza', 'Sabão líquido'] },
  { id: 282, path: ['Limpeza', 'Amaciante de roupas'] },
  { id: 283, path: ['Limpeza', 'Água sanitária e cloros'] },
  { id: 284, path: ['Limpeza', 'Desinfetantes'] },
  { id: 285, path: ['Limpeza', 'Multiuso e limpadores'] },
  { id: 286, path: ['Limpeza', 'Detergente de louça'] },
  { id: 287, path: ['Limpeza', 'Esponjas e panos'] },
  { id: 288, path: ['Limpeza', 'Vassouras e rodos'] },
  { id: 289, path: ['Limpeza', 'Sacos de lixo'] },
  { id: 290, path: ['Limpeza', 'Alvejantes e tira-manchas'] },
  { id: 291, path: ['Limpeza', 'Lustra-móveis e ceras'] },
  { id: 292, path: ['Limpeza', 'Inseticidas e repelentes'] },

  // Perfumaria e higiene
  { id: 300, path: ['Perfumaria e higiene', 'Sabonete em barra'] },
  { id: 301, path: ['Perfumaria e higiene', 'Sabonete líquido'] },
  { id: 302, path: ['Perfumaria e higiene', 'Shampoo e condicionador'] },
  { id: 303, path: ['Perfumaria e higiene', 'Creme dental'] },
  { id: 304, path: ['Perfumaria e higiene', 'Escova de dentes e fio dental'] },
  { id: 305, path: ['Perfumaria e higiene', 'Desodorante'] },
  { id: 306, path: ['Perfumaria e higiene', 'Papel higiênico'] },
  { id: 307, path: ['Perfumaria e higiene', 'Lenços umedecidos'] },
  { id: 308, path: ['Perfumaria e higiene', 'Absorventes e protetores'] },
  { id: 309, path: ['Perfumaria e higiene', 'Fraldas'] },
  { id: 310, path: ['Perfumaria e higiene', 'Cremes e loções'] },

  // Bebê
  { id: 330, path: ['Infantil', 'Fórmulas infantis e papinhas'] },
  { id: 331, path: ['Infantil', 'Acessórios para bebê'] },

  // Pet
  { id: 350, path: ['Pet', 'Ração para cães'] },
  { id: 351, path: ['Pet', 'Ração para gatos'] },
  { id: 352, path: ['Pet', 'Acessórios pet'] },

  // Utilidades e bazar
  { id: 370, path: ['Utilidades', 'Filtros e descartáveis'] },
  { id: 371, path: ['Utilidades', 'Pilhas e lâmpadas'] },
  { id: 372, path: ['Utilidades', 'Velas e fósforos'] },

  // Fallback
  { id: 999, path: ['Outros'] },
];

export const TAXONOMY_BY_ID = new Map<number, TaxonomyCategory>(
  TAXONOMY_CATEGORIES.map((c) => [c.id, c]),
);
