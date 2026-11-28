/**
 * As 11 categorias do item, na grafia da chave: "Frios e Laticinios" sem acento (o rótulo "Frios e Laticínios" é só da
 * tela). "Sem categoria" não é valor: é `null`. Lista própria do módulo, sem importar o serviço de IA; um teste compara
 * as duas listas.
 */
export const FLYER_PRO_CATEGORIES = [
  'Hortifruti',
  'Carnes',
  'Frios e Laticinios',
  'Padaria',
  'Bebidas',
  'Mercearia',
  'Congelados',
  'Limpeza',
  'Higiene e Perfumaria',
  'Pet',
  'Bazar',
] as const;

/** As cinco unidades do protótipo (PU-26). */
export const FLYER_PRO_UNITS = ['cada', 'kg', '100g', 'pct', 'bdj'] as const;

/** De onde a foto do item veio. */
export const FLYER_PRO_IMAGE_ORIGINS = [
  'match',
  'suggestion',
  'picker',
  'upload',
  'pixabay',
  'google',
] as const;
