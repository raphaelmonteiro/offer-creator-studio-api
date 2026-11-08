import { directorPlan, directorRaw } from '../testing/scene-director-fixtures';
import { DirectorValidationContext, DIRECTOR_JSON_SCHEMA, parseDirector } from './scene-director';

const ctxFor = (
  message: string,
  extra: Partial<DirectorValidationContext> = {},
): DirectorValidationContext => ({
  message,
  marked: false,
  clientMessages: [message],
  briefItems: [],
  ...extra,
});

describe('parseDirector', () => {
  describe('Saída inválida', () => {
    it.each([
      ['texto que não é JSON', 'olá'],
      ['JSON sem campo obrigatório', JSON.stringify({ turn_kind: 'pergunta' })],
      ['classe fora da lista', JSON.stringify({ ...directorPlan(), turn_kind: 'conversa' })],
      ['campo a mais', JSON.stringify({ ...directorPlan(), box: [0, 0, 1, 1] })],
      ['reply acima de 260 caracteres', directorRaw({ reply: 'x'.repeat(261) })],
      [
        'preservação com mais de 12 itens',
        directorRaw({ what_to_change: 'x', inventory_keep: Array(13).fill('coelho') }),
      ],
      [
        'recusa de texto, que não existe mais',
        JSON.stringify({ ...directorPlan(), refusal: 'painted_text' }),
      ],
      [
        'will_change_image como texto',
        JSON.stringify({ ...directorPlan(), will_change_image: 'sim' }),
      ],
    ])('recusa %s', (_name, raw) => {
      const result = parseDirector(raw, ctxFor('oi'));
      expect(result.ok).toBe(false);
    });

    it('aceita o plano válido e devolve os campos tipados', () => {
      const result = parseDirector(directorRaw({ reply: 'Olá!' }), ctxFor('oi'));
      expect(result).toMatchObject({ ok: true, plan: { turn_kind: 'pergunta', reply: 'Olá!' } });
    });

    it('undo_target aceita null, previous e número exibido', () => {
      for (const undo_target of [null, 'previous', 3] as const) {
        const raw = directorRaw({ turn_kind: 'desfazer', undo_target });
        expect(parseDirector(raw, ctxFor('volta')).ok).toBe(true);
      }
      const bad = JSON.stringify({ ...directorPlan(), undo_target: 'anterior' });
      expect(parseDirector(bad, ctxFor('volta')).ok).toBe(false);
    });
  });

  describe('Texto fora da mensagem', () => {
    const op = (value: string) => ({
      op: 'set_text' as const,
      layer: null,
      text: { value, placement: 'bottom' as const },
      position: null,
      replace: false,
    });

    it('recusa texto de camada que não está na mensagem', () => {
      const raw = directorRaw({ turn_kind: 'camada', layer_ops: [op('Oferta imperdível')] });
      expect(parseDirector(raw, ctxFor('escreve "Ofertas da semana" embaixo'))).toEqual({
        ok: false,
        reason: 'texto exato fora da mensagem',
      });
    });

    it('aceita texto literal, mesmo com espaços repetidos na mensagem', () => {
      const raw = directorRaw({ turn_kind: 'camada', layer_ops: [op('Ofertas da semana')] });
      const message = 'escreve "Ofertas   da semana" embaixo';
      expect(parseDirector(raw, ctxFor(message)).ok).toBe(true);
    });

    it('recusa operação sem o que precisa', () => {
      const move = {
        op: 'move' as const,
        layer: null,
        text: null,
        position: null,
        replace: false,
      };
      expect(parseDirector(directorRaw({ layer_ops: [move] }), ctxFor('move')).ok).toBe(false);
      const logo = { ...move, op: 'add_logo' as const };
      expect(parseDirector(directorRaw({ layer_ops: [logo] }), ctxFor('logo')).ok).toBe(false);
    });
  });

  describe('position.below (B3, D-59)', () => {
    const textOp = (position: unknown) => ({
      op: 'set_text' as const,
      layer: null,
      text: { value: 'Ofertas da semana', placement: 'below-logo' as const },
      position,
      replace: false,
    });
    const message = 'escreve "Ofertas da semana" embaixo da logo';

    it('aceita a camada de referência, e o plano sem `below` segue válido', () => {
      const withBelow = textOp({
        side: 'left',
        zone: 'header',
        below: { kind: 'logo', name: null },
      });
      const raw = directorRaw({ turn_kind: 'camada', layer_ops: [withBelow] });
      expect(parseDirector(raw, ctxFor(message)).ok).toBe(true);
      const old = directorRaw({
        turn_kind: 'camada',
        layer_ops: [textOp({ side: 'left', zone: 'header' })],
      });
      expect(parseDirector(old, ctxFor(message)).ok).toBe(true);
    });

    it('recusa `below` com tipo fora da lista ou campo a mais', () => {
      const bad = (below: unknown) =>
        directorRaw({
          turn_kind: 'camada',
          layer_ops: [textOp({ side: 'left', zone: 'header', below })],
        });
      expect(parseDirector(bad({ kind: 'foto', name: null }), ctxFor(message)).ok).toBe(false);
      expect(parseDirector(bad({ kind: 'logo', name: null, extra: 1 }), ctxFor(message)).ok).toBe(
        false,
      );
    });

    it('o JSON schema pede `below` em `position`, nulo ou com tipo e nome', () => {
      type Node = {
        properties?: Record<string, Node>;
        anyOf?: Node[];
        required?: string[];
        items?: Node;
      };
      const ops = (DIRECTOR_JSON_SCHEMA.schema as Node).properties?.layer_ops as Node;
      const position = ops.items?.properties?.position as Node;
      const object = position.anyOf?.find((node) => node.properties) as Node;
      expect(object.required).toEqual(['side', 'zone', 'below']);
      const below = object.properties?.below as Node;
      expect(below.anyOf?.some((node) => node.required?.join() === 'kind,name')).toBe(true);
    });
  });

  describe('Diretor inventa pedido', () => {
    const request = (text: string) => ({ id: null, text, action: 'open' as const, quote: null });

    it('recusa pedido sem palavra de nenhuma mensagem do cliente', () => {
      const raw = directorRaw({ turn_kind: 'pedido_item', requests: [request('borboleta')] });
      const ctx = ctxFor('coloca um coelho no rodapé', {
        clientMessages: ['quero um campo', 'coloca um coelho no rodapé'],
      });
      expect(parseDirector(raw, ctx)).toMatchObject({ ok: false });
    });

    it('aceita pedido que usa palavra de uma mensagem anterior, inclusive no plural', () => {
      const raw = directorRaw({
        turn_kind: 'pedido_item',
        requests: [request('coelhos no rodapé')],
      });
      const ctx = ctxFor('agora faz mais', {
        clientMessages: ['coloca um coelho ali', 'agora faz mais'],
      });
      expect(parseDirector(raw, ctx).ok).toBe(true);
    });

    it('palavra de ligação sozinha não prova nada', () => {
      const raw = directorRaw({ requests: [request('de uma')] });
      expect(parseDirector(raw, ctxFor('coloca um rio')).ok).toBe(false);
    });
  });

  describe('Diretor tenta desistir sozinho', () => {
    const drop = (quote: string | null, id: string | null = 'rio-1') => ({
      id,
      text: 'rio',
      action: 'drop' as const,
      quote,
    });

    it('recusa drop com citação que não está na mensagem', () => {
      const raw = directorRaw({ requests: [drop('esquece o rio')] });
      const ctx = ctxFor('deixa mais quente', {
        clientMessages: ['quero um rio no meio', 'deixa mais quente'],
        briefItems: [{ id: 'rio-1', text: 'um rio no meio' }],
      });
      expect(parseDirector(raw, ctx)).toMatchObject({ ok: false });
    });

    it('recusa drop sem citação e drop de id que não está na lista', () => {
      const ctx = ctxFor('esquece o rio', {
        briefItems: [{ id: 'rio-1', text: 'um rio no meio' }],
      });
      expect(parseDirector(directorRaw({ requests: [drop(null)] }), ctx).ok).toBe(false);
      expect(
        parseDirector(directorRaw({ requests: [drop('esquece o rio', 'outro')] }), ctx).ok,
      ).toBe(false);
    });

    it.each(['esquece isso', 'deixa pra la', 'desisto', 'não precisa', 'não quero mais'])(
      'Esquece isso: a desistência genérica "%s" é citação válida, sem palavra do item',
      (quote) => {
        const raw = directorRaw({ requests: [drop(quote, 'p1')] });
        const ctx = ctxFor(quote, { briefItems: [{ id: 'p1', text: 'um rio no meio' }] });
        expect(parseDirector(raw, ctx).ok).toBe(true);
      },
    );

    it('R10: drop do coelho com a citação "de" numa mensagem que não fala dele é recusado', () => {
      const raw = directorRaw({ requests: [drop('de', 'p1')] });
      const ctx = ctxFor('muda a cor de fundo', {
        briefItems: [{ id: 'p1', text: 'um coelho' }],
      });
      expect(parseDirector(raw, ctx)).toMatchObject({ ok: false });
    });

    it('R10: citação de outra palavra da mensagem, que não é a do item, também é recusada', () => {
      const raw = directorRaw({ requests: [drop('cor de fundo', 'p1')] });
      const ctx = ctxFor('muda a cor de fundo', {
        briefItems: [{ id: 'p1', text: 'um coelho' }],
      });
      expect(parseDirector(raw, ctx)).toMatchObject({ ok: false });
    });

    it('aceita drop com citação literal da mensagem atual, sem diferenciar acento ou caixa', () => {
      const raw = directorRaw({ requests: [drop('Esquece o RIO')] });
      const ctx = ctxFor('esquece o rio por favor', {
        clientMessages: ['quero um rio', 'esquece o rio por favor'],
        briefItems: [{ id: 'rio-1', text: 'um rio no meio' }],
      });
      expect(parseDirector(raw, ctx).ok).toBe(true);
    });
  });

  describe('Nome curto', () => {
    it('"tira a TV" é aceito, sem recusa por palavra curta', () => {
      const raw = directorRaw({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: 'remover a TV',
        requests: [{ id: null, text: 'tirar a TV', action: 'open', quote: null }],
      });
      expect(parseDirector(raw, ctxFor('tira a TV')).ok).toBe(true);
    });
  });
});

describe('DIRECTOR_JSON_SCHEMA', () => {
  type Node = {
    type?: unknown;
    properties?: Record<string, Node>;
    required?: string[];
    additionalProperties?: boolean;
    items?: Node;
    anyOf?: Node[];
  };

  function assertStrict(node: Node, path: string): void {
    if (node.anyOf) node.anyOf.forEach((child, i) => assertStrict(child, `${path}.anyOf${i}`));
    if (node.items) assertStrict(node.items, `${path}[]`);
    if (node.properties) {
      expect({ path, additionalProperties: node.additionalProperties }).toEqual({
        path,
        additionalProperties: false,
      });
      expect({ path, required: [...(node.required ?? [])].sort() }).toEqual({
        path,
        required: Object.keys(node.properties).sort(),
      });
      for (const [key, child] of Object.entries(node.properties)) {
        assertStrict(child, `${path}.${key}`);
      }
    }
  }

  it('é estrito em todo objeto: todos os campos exigidos, nenhum a mais', () => {
    assertStrict(DIRECTOR_JSON_SCHEMA.schema as Node, 'raiz');
    expect(DIRECTOR_JSON_SCHEMA.name).toBe('scene_director');
  });

  it('não tem o campo box do protótipo', () => {
    expect(Object.keys((DIRECTOR_JSON_SCHEMA.schema as Node).properties ?? {})).not.toContain(
      'box',
    );
  });
});

describe('Blocos de imagem (D-51)', () => {
  const marked = (zone: string) =>
    directorRaw({ what_to_change: 'x', turn_kind: 'pedido_item', will_change_image: true }).replace(
      '"zone":"whole"',
      `"zone":"${zone}"`,
    );

  it('Região marcada sem marcação é saída inválida; com marcação, vale', () => {
    expect(parseDirector(marked('marked'), ctxFor('tira isso'))).toMatchObject({ ok: false });
    expect(parseDirector(marked('marked'), ctxFor('tira isso', { marked: true })).ok).toBe(true);
    expect(parseDirector(marked('footer'), ctxFor('tira isso')).ok).toBe(true);
  });

  it('Item longo: requests.text acima de 80 caracteres e exact_text com mais de 4 linhas ou 80 caracteres são inválidos', () => {
    const request = { id: null, text: 'x'.repeat(81), action: 'open', quote: null };
    expect(parseDirector(directorRaw({ requests: [request] as never }), ctxFor('x')).ok).toBe(
      false,
    );
    for (const lines of [Array(5).fill('a'), ['x'.repeat(81)]]) {
      expect(parseDirector(directorRaw({ exact_text: lines }), ctxFor('a')).ok).toBe(false);
    }
  });

  it('o JSON schema traz image com os seis blocos e sem os campos antigos', () => {
    type SchemaNode = { properties?: Record<string, SchemaNode>; anyOf?: SchemaNode[] };
    const props = (DIRECTOR_JSON_SCHEMA.schema as SchemaNode).properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['image', 'refusal']));
    for (const gone of ['what_to_change', 'what_to_put', 'inventory_keep']) {
      expect(Object.keys(props)).not.toContain(gone);
    }
    const image = (props.image as SchemaNode).anyOf?.find((node) => node.properties) as SchemaNode;
    expect(Object.keys(image.properties ?? {}).sort()).toEqual(
      ['change', 'composition', 'exact_text', 'preserve', 'region', 'style'].sort(),
    );
  });
});
