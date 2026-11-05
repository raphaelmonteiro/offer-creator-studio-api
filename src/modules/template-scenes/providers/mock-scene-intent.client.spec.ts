import { parseIntent } from '../domain/scene-intent';
import { MockSceneIntentClient } from './mock-scene-intent.client';
import { SceneIntentCall } from './scene-intent-client';

const call = (message: string, marked = false): SceneIntentCall => ({
  model: 'mock',
  system: '',
  user: '',
  jsonSchema: { name: 'x', schema: {} },
  timeoutMs: 1000,
  correlationId: 'c',
  message,
  marked,
});

const classify = async (message: string, marked = false) => {
  const result = await new MockSceneIntentClient().classify(call(message, marked));
  return { result, parsed: parseIntent(result.text, message) };
};

describe('MockSceneIntentClient', () => {
  it('acha a mensagem no conjunto de avaliação, sem custo', async () => {
    const { result, parsed } = await classify('deixa tudo mais quente');
    expect(parsed).toMatchObject({ ok: true, intent: { action: 'global_adjust' } });
    expect(result.usage).toBeNull();
  });

  it('a marcação escolhe a saída esperada da mesma frase', async () => {
    expect((await classify('coloca um balão de ar quente', true)).parsed).toMatchObject({
      intent: { action: 'edit' },
    });
    expect((await classify('coloca um balão de ar quente', false)).parsed).toMatchObject({
      intent: { action: 'add_element', subject: 'balão de ar quente' },
    });
  });

  it('ignora caixa, acento e espaços na procura', async () => {
    expect((await classify('  DEIXA  tudo mais quente ')).parsed).toMatchObject({
      intent: { action: 'global_adjust' },
    });
  });

  it('sem casar: edit com marcação e ask_region sem ela', async () => {
    expect((await classify('frase que ninguém previu', true)).parsed).toMatchObject({
      intent: { action: 'edit' },
    });
    expect((await classify('frase que ninguém previu', false)).parsed).toMatchObject({
      intent: { action: 'ask_region' },
    });
  });

  it('#intencao=<ação> devolve essa ação, com o que ela exige', async () => {
    expect((await classify('qualquer #intencao=new_image')).parsed).toMatchObject({
      intent: { action: 'new_image' },
    });
    expect((await classify('um balão #intencao=add_element')).parsed).toMatchObject({
      intent: { action: 'add_element', subject: 'um balão' },
    });
    expect((await classify('escreve "Oi" #intencao=set_text')).parsed).toMatchObject({
      intent: { action: 'set_text', text: { value: 'Oi' } },
    });
    expect((await classify('a logo #intencao=layer_move')).parsed).toMatchObject({
      intent: { action: 'layer_move', layer: { kind: 'logo' } },
    });
  });

  it('#intencao-invalida devolve texto que não é JSON, e #falha-intencao lança', async () => {
    expect((await classify('x #intencao-invalida')).parsed.ok).toBe(false);
    await expect(classify('x #falha-intencao')).rejects.toThrow('indisponível');
  });
});
