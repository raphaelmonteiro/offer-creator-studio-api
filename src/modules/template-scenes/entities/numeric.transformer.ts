import { ValueTransformer } from 'typeorm';

/** `numeric` do Postgres volta como string: converte para número na leitura. */
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null) =>
    value === null || value === undefined ? null : Number(value),
};
