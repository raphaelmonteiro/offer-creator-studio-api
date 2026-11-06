import { fold } from './fold';

describe('fold', () => {
  it('tira acento e caixa sem mudar o comprimento', () => {
    expect(fold('Páscoa AÇÚCAR Cabeçalho')).toBe('pascoa acucar cabecalho');
    expect(fold('Rodapé').length).toBe('Rodapé'.length);
  });

  it('texto sem acento passa igual, e vazio continua vazio', () => {
    expect(fold('coelho')).toBe('coelho');
    expect(fold('')).toBe('');
  });
});
