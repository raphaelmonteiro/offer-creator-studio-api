import { dilateBinary, erodeBinary } from '../../../shared/image/morphology';

/**
 * Morfologia binária das máscaras 0/1 do recorte. A implementação é a única do app, em
 * `shared/image/morphology.ts` (O(n) por raio, DT-10); aqui só ficam os nomes e a assinatura que o
 * recorte já usa.
 */

/** Máscara binária dilatada em `radius` px (janela quadrada, separável). */
export const dilate = dilateBinary;

/** Erosão: o que está fora da imagem conta como preenchido. */
export const erode = erodeBinary;
