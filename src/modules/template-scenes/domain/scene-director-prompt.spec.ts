import { directorPlan } from '../testing/scene-director-fixtures';
import { checkComposition } from './scene-director-composition';
import { DIRECTOR_INSTRUCTIONS } from './scene-director-prompt';

/**
 * R67: o exemplo de ancoragem do prompt do Diretor não pode usar termo de divisão que a validação 5 barra, senão o
 * Diretor recebe duas ordens contrárias e um pedido normal vira pergunta de composição.
 */
describe('Exemplos do prompt do Diretor passam pela validação 5 (R67)', () => {
  const rule =
    DIRECTOR_INSTRUCTIONS.split('\n').find((line) => line.includes('ancore o objeto')) ?? '';
  const examples = [...rule.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  it('a regra de ancoragem existe e traz exemplos entre aspas', () => {
    expect(rule).not.toBe('');
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['embaixo', 'coloca uma placa de madeira embaixo'],
    ['em cima', 'coloca uma placa de madeira em cima'],
  ])('com a mensagem "%s" sem termo de divisão, nenhum exemplo é barrado', (_name, message) => {
    for (const example of examples) {
      const plan = directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: `Add a wooden sign ${example}`,
      });
      expect(checkComposition(plan, [message])).toEqual({ ok: true });
    }
  });
});

describe('Regras de D-59 no prompt do Diretor', () => {
  const lineWith = (text: string) =>
    DIRECTOR_INSTRUCTIONS.split('\n').find((line) => line.includes(text)) ?? '';

  it('Mensagem que se contradiz: pergunta curta com as opções, sem imagem e sem pedido', () => {
    const rule = lineWith('não podem valer juntas');
    expect(rule).toContain('will_change_image false');
    expect(rule).toContain('image nulo');
    expect(rule).toContain('requests vazio');
    expect(rule).toContain('UMA pergunta curta que cita as duas opções');
    expect(rule).toContain('Duas mudanças que podem valer juntas também não são contradição');
  });

  it('Mensagem que se contradiz (B5): o exemplo do dono, variações e o que não é contradição', () => {
    const rule = lineWith('não podem valer juntas');
    expect(rule).toContain(
      'escreve nela promoção de páscoa, e eu quero que o texto oferta de páscoa',
    );
    expect(rule).toContain('colocar e tirar a mesma coisa');
    expect(rule).toContain('duas cores para o mesmo objeto');
    expect(rule).toContain('NÃO é contradição: duas frases em linhas diferentes pedidas como tal');
    expect(rule).toContain('De R$ 19,90 por R$ 9,90');
  });

  it('Item do turno anterior: só é executado quando a mensagem atual o pede, com o mesmo id', () => {
    const rule = lineWith('só os do turno anterior');
    expect(rule).toContain('mesmo id');
    expect(rule).toContain('Um pedido novo sobre outra coisa não arrasta o anterior');
  });
});
