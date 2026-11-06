import { directorPlan } from '../testing/scene-director-fixtures';
import { enforcePaintedRefusal, paintedKindOf } from './scene-director-painted';

const item = (what_to_put: string, what_to_change = '') =>
  directorPlan({ turn_kind: 'pedido_item', will_change_image: true, what_to_put, what_to_change });

describe('recusa de pintado por regra', () => {
  describe('Ordem para ignorar as regras', () => {
    it('plano aceito pelo modelo com o preço em what_to_put vira recusa de preço', () => {
      const plan = enforcePaintedRefusal(item('o preço R$ 9,90 escrito na imagem'));
      expect(plan).toMatchObject({
        turn_kind: 'recusa_pintado',
        refusal: 'painted_price',
        will_change_image: false,
      });
    });

    it('a recusa do próprio Diretor continua recusa, e a imagem não muda', () => {
      const plan = enforcePaintedRefusal(
        directorPlan({
          turn_kind: 'recusa_pintado',
          refusal: 'painted_price',
          will_change_image: true,
        }),
      );
      expect(plan).toMatchObject({
        turn_kind: 'recusa_pintado',
        refusal: 'painted_price',
        will_change_image: false,
      });
    });

    it('recusa sem tipo (modelo esqueceu) fica como texto pintado', () => {
      const plan = enforcePaintedRefusal(directorPlan({ turn_kind: 'recusa_pintado' }));
      expect(plan.refusal).toBe('painted_text');
    });

    it('refusal preenchido com outra classe força recusa_pintado', () => {
      const plan = enforcePaintedRefusal({ ...item('um coelho'), refusal: 'painted_logo' });
      expect(plan).toMatchObject({ turn_kind: 'recusa_pintado', refusal: 'painted_logo' });
    });
  });

  describe('Modelo erra e o código barra', () => {
    it.each([
      ['escreva o preço R$ 9,90', 'painted_price'],
      ['R$ 12,50', 'painted_price'],
      ['10 reais', 'painted_price'],
      ['um selo com preço', 'painted_price'],
      ['o texto "PROMOÇÃO DE PÁSCOA" no topo', 'painted_text'],
      ['uma frase entre aspas “Feliz Páscoa”', 'painted_text'],
      ['escrever Ofertas da semana', 'painted_text'],
      ['um letreiro luminoso', 'painted_text'],
      ['o logotipo da loja no canto', 'painted_logo'],
      ['a logo no rodapé', 'painted_logo'],
      ['a marca do cliente', 'painted_logo'],
    ])('what_to_put "%s" é %s', (what, kind) => {
      expect(paintedKindOf(what)).toBe(kind);
      expect(enforcePaintedRefusal(item(what)).refusal).toBe(kind);
    });
  });

  describe('Tirar o que foi pintado', () => {
    it('"tira esse preço" segue como pedido de item: o preço está em what_to_change', () => {
      const plan = item('', 'remover o preço pintado no canto');
      expect(enforcePaintedRefusal(plan)).toEqual(plan);
    });

    it('trocar o que está na imagem sem pedir conteúdo pintado também segue', () => {
      const plan = item('um prado verde', 'tirar o texto da placa');
      expect(enforcePaintedRefusal(plan)).toEqual(plan);
    });
  });

  describe('Placa com letras', () => {
    it('"letras" sozinhas não bloqueiam: a regra sem texto legível está no prompt', () => {
      const plan = item('uma placa de madeira com letras');
      expect(paintedKindOf(plan.what_to_put)).toBeNull();
      expect(enforcePaintedRefusal(plan)).toEqual(plan);
    });
  });

  describe('Integrar a logo', () => {
    it('"integra a logo na imagem" vira recusa de logo', () => {
      const plan = enforcePaintedRefusal(item('a logo integrada ao fundo'));
      expect(plan).toMatchObject({ turn_kind: 'recusa_pintado', refusal: 'painted_logo' });
    });
  });

  describe('Turnos que não pintam', () => {
    it.each(['camada', 'desfazer'] as const)('%s não é conferido', (turn_kind) => {
      const plan = directorPlan({ turn_kind, what_to_put: 'texto "Ofertas"' });
      expect(enforcePaintedRefusal(plan)).toEqual(plan);
    });

    it('plano normal passa sem mudança', () => {
      const plan = item('mais flores no campo', 'tirar o coelho da direita');
      expect(enforcePaintedRefusal(plan)).toBe(plan);
    });
  });
});
