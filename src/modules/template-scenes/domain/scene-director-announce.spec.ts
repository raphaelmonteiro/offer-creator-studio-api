import { directorImage, directorPlan, PlanOverrides } from '../testing/scene-director-fixtures';
import { AnnounceSources, checkAnnouncement } from './scene-director-announce';

const none: AnnounceSources = { paintedText: [], layerTexts: [] };
const plan = (reply: string, over: PlanOverrides = {}) =>
  directorPlan({ turn_kind: 'pedido_item', will_change_image: true, reply, ...over });
const bad = (reply: string, over: PlanOverrides = {}, sources = none) =>
  checkAnnouncement(plan(reply, over), sources).ok;

describe('Anúncio contra o plano (validação 9)', () => {
  describe('Frase', () => {
    it('cita a frase que o plano pinta: passa', () => {
      const over = { what_to_change: 'Add a wooden sign', exact_text: ['Promoção de Páscoa'] };
      expect(bad('Vou colocar uma placa com a frase “Promoção de Páscoa”', over)).toBe(true);
      expect(bad('Vou colocar uma placa com a frase "Promoção de Páscoa"', over)).toBe(true);
    });

    it('cita a frase do set_text, a já pintada ou a de uma camada: passa', () => {
      const setText = {
        op: 'set_text' as const,
        layer: null,
        position: null,
        replace: false,
        text: { value: 'Frete grátis' },
      };
      const withOp = { what_to_change: 'Add a sign', layer_ops: [setText] } as PlanOverrides;
      expect(bad('Vou pintar uma placa e pôr “Frete grátis” como camada', withOp)).toBe(true);
      expect(
        bad(
          'Vou manter “Oferta” e colocar mais margaridas',
          { what_to_change: 'Add more daisies' },
          {
            paintedText: ['Oferta'],
            layerTexts: [],
          },
        ),
      ).toBe(true);
      expect(
        bad(
          'Vou pintar “Promoção de Páscoa” na madeira',
          { what_to_change: 'Wooden sign' },
          {
            paintedText: [],
            layerTexts: ['Promoção de Páscoa'],
          },
        ),
      ).toBe(true);
    });

    it('Anúncio cita frase cortada: a frase que 4b tirou de image.change não está no plano', () => {
      const over = { what_to_change: 'Add a sign on the footer' };
      const result = checkAnnouncement(
        plan('Vou colocar uma placa com “SALE 50% OFF”', over),
        none,
      );
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.reason).toContain('SALE 50% OFF');
    });
  });

  describe('Escrita sem texto', () => {
    it.each([
      'Vou dar um efeito realista de gravação na placa',
      'Vou deixar a frase escrita na madeira',
      'Vou colocar uma placa com a frase de Páscoa',
      'Vou colocar um letreiro de madeira',
    ])('Anúncio promete escrita que o plano não traz: "%s"', (reply) => {
      expect(bad(reply, { what_to_change: 'Add a wooden sign' })).toBe(false);
    });

    it('com exact_text preenchido ou set_text, a promessa de escrita passa', () => {
      const over = { what_to_change: 'Add a wooden sign', exact_text: ['Oferta'] };
      expect(bad('Vou colocar uma placa com a frase de Páscoa', over)).toBe(true);
    });

    it('depois de verbo de tirar, não é promessa de escrita', () => {
      expect(bad('Vou tirar o texto escrito da placa', { what_to_change: 'Remove the sign' })).toBe(
        true,
      );
      expect(bad('Vou remover o letreiro', { what_to_change: 'Remove the sign' })).toBe(true);
    });
  });

  describe('Placa', () => {
    it.each(['sign', 'wooden board', 'plaque', 'a placard'])(
      'promete placa e image.change traz "%s": passa',
      (word) => {
        expect(bad('Vou colocar uma placa de madeira', { what_to_change: `Add ${word}` })).toBe(
          true,
        );
      },
    );

    it('promete placa ou cartaz e image.change não traz: refaz', () => {
      expect(bad('Vou colocar uma placa de madeira', { what_to_change: 'Add more daisies' })).toBe(
        false,
      );
      expect(bad('Vou colocar um cartaz grande', { what_to_change: 'Add a big frame' })).toBe(
        false,
      );
    });

    it('sem placa no anúncio, nada a conferir', () => {
      expect(bad('Vou colocar mais margaridas no rodapé', { what_to_change: 'Add daisies' })).toBe(
        true,
      );
    });
  });

  describe('Camada', () => {
    it('promete camada com layer_ops vazio: refaz', () => {
      expect(bad('Vou pintar a placa e deixar o texto editável', { what_to_change: 'Sign' })).toBe(
        false,
      );
      expect(bad('A logo vai numa camada', { what_to_change: 'More daisies' })).toBe(false);
    });

    it('oferta condicional passa, e camada com layer_ops passa', () => {
      expect(
        bad('Vou pintar a placa. Se quiser, o texto vira camada depois', {
          what_to_change: 'Add a sign',
          exact_text: ['Oferta'],
        }),
      ).toBe(true);
      const op = {
        op: 'remove' as const,
        layer: { kind: 'logo' },
        text: null,
        position: null,
        replace: false,
      };
      expect(
        bad('Vou mover a camada da logo', {
          what_to_change: 'More daisies',
          layer_ops: [op],
        } as PlanOverrides),
      ).toBe(true);
    });
  });

  describe('Segunda mudança não feita (R74, D-54)', () => {
    const removeOnly = { what_to_change: 'Remove the bunny' };

    it.each([
      'Vou tirar o coelho e colocar uma placa de madeira no rodapé.',
      'Vou remover o coelho e colocar uma placa com a frase de oferta.',
      'Vou tirar o coelho e pôr o texto como camada editável.',
      'Vou tirar o coelho, colocar uma placa de madeira.',
      'Vou tirar o coelho; colocar uma placa.',
    ])('promessa da segunda mudança é barrada: "%s"', (reply) => {
      expect(bad(reply, removeOnly)).toBe(false);
    });

    it('o mesmo anúncio sem a segunda mudança passa, e o texto fixo de "Ainda falta" não é anúncio', () => {
      expect(bad('Vou tirar o coelho.', removeOnly)).toBe(true);
      expect(bad('Vou remover o coelho do campo.', removeOnly)).toBe(true);
    });

    it('a isenção vale quando o plano de fato remove a placa ou a escrita', () => {
      expect(
        bad('Vou tirar a placa escrita do rodapé.', { what_to_change: 'Remove the board' }),
      ).toBe(true);
      expect(
        bad('Vou tirar a placa do rodapé.', { what_to_change: 'Remove the wooden sign' }),
      ).toBe(true);
    });

    it('verbo de tirar sem remoção no plano não isenta a placa nem a escrita', () => {
      expect(bad('Vou tirar a placa do rodapé.', { what_to_change: 'Add more daisies' })).toBe(
        false,
      );
      expect(bad('Vou tirar o texto escrito do rodapé.', { what_to_change: 'Add daisies' })).toBe(
        false,
      );
      expect(bad('Vou tirar a placa e colocar flores.', { what_to_change: 'Add flowers' })).toBe(
        false,
      );
    });

    it('camada: o verbo de tirar não isenta a promessa com layer_ops vazio', () => {
      expect(bad('Vou tirar o coelho e deixar o texto como camada.', removeOnly)).toBe(false);
    });
  });

  it('nome de camada existente entre aspas não é frase a pintar (PV-103)', () => {
    const move = {
      op: 'move' as const,
      layer: { kind: 'logo' },
      text: null,
      position: null,
      replace: false,
    };
    const over = { what_to_change: 'More daisies', layer_ops: [move] } as PlanOverrides;
    const reply = 'Vou colocar mais margaridas e mover a camada “Logo” para a direita.';
    expect(bad(reply, over)).toBe(false);
    expect(bad(reply, over, { paintedText: [], layerTexts: [], layerNames: ['Logo'] })).toBe(true);
    expect(bad(reply.replace('Logo', 'Selo'), over, { ...none, layerNames: ['Logo'] })).toBe(false);
  });

  it('reply vazio não promete nada', () => {
    expect(checkAnnouncement({ ...plan(''), image: directorImage() }, none)).toEqual({ ok: true });
  });
});
