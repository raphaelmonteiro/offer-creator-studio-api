import type { FLYER_PRO_CATEGORIES } from '../domain/flyer-pro-categories';

/** As tabelas fixas do provedor simulado do job (A-15): palavras por categoria e grafias conhecidas. Sem rede, sem custo. */

type Category = (typeof FLYER_PRO_CATEGORIES)[number];

/** Palavras (sem acento, em maiúsculas) que levam a cada uma das 11 categorias; a primeira palavra do nome que estiver aqui vale. */
export const CATEGORY_WORDS: Record<Category, readonly string[]> = {
  Hortifruti: [
    'ABACATE',
    'BANANA',
    'TOMATE',
    'ALFACE',
    'CEBOLA',
    'BATATA',
    'LARANJA',
    'MACA',
    'CENOURA',
  ],
  Carnes: ['COXA', 'FRANGO', 'CARNE', 'PICANHA', 'ACEM', 'LINGUICA', 'BIFE', 'COSTELA'],
  'Frios e Laticinios': ['QUEIJO', 'PRESUNTO', 'IOGURTE', 'LEITE', 'MANTEIGA', 'MUSSARELA'],
  Padaria: ['PAO', 'BOLO', 'BISNAGA', 'ROSCA', 'TORRADA'],
  Bebidas: ['CERVEJA', 'REFRIGERANTE', 'SUCO', 'VINHO', 'ENERGETICO'],
  Mercearia: ['ARROZ', 'FEIJAO', 'MACARRAO', 'AZEITE', 'ACUCAR', 'FARINHA', 'OLEO', 'CAFE'],
  Congelados: ['SORVETE', 'PIZZA', 'LASANHA', 'HAMBURGUER', 'EMPANADO'],
  Limpeza: ['SABAO', 'DETERGENTE', 'AMACIANTE', 'DESINFETANTE', 'ALVEJANTE', 'LIMPADOR'],
  'Higiene e Perfumaria': ['SABONETE', 'SHAMPOO', 'CONDICIONADOR', 'DESODORANTE', 'ABSORVENTE'],
  Pet: ['RACAO', 'PETISCO', 'AREIA'],
  Bazar: ['PILHA', 'LAMPADA', 'VASSOURA', 'BALDE', 'FOSFORO'],
};

/** Grafias que o simulado corrige: a palavra sem acento, em maiúsculas, e como fica. */
export const SPELLING_FIXES: Readonly<Record<string, string>> = {
  CONJELADO: 'CONGELADO',
  CONJELADA: 'CONGELADA',
  FILE: 'FILÉ',
  TILAPIA: 'TILÁPIA',
  LINGUISA: 'LINGUIÇA',
  XOCOLATE: 'CHOCOLATE',
  IORGUTE: 'IOGURTE',
};
