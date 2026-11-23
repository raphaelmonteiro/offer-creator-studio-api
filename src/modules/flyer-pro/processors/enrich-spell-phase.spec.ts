import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { SpellCheckService } from '../../ai/spell-check.service';
import { answer, build as buildService } from '../../ai/spell-check.service.testutil';
import { fakeConfig, openAiError, chatResponse } from '../../ai/utils/openai-chat.testutil';
import { callContext, itemInput } from '../providers/flyer-pro-enrich.testutil';
import { EnrichSpellPhase } from './enrich-spell-phase';

function build(env: Record<string, string> = {}) {
  const { service, create } = buildService(env);
  return { service, create, phase: new EnrichSpellPhase(service) };
}

const file = itemInput('FILE DE TILAPIA CONJELADO', { id: 'file' });
const abacate = itemInput('ABACATE', { id: 'abacate' });

const correction = (productId: string, suggestion: string, field = 'name') => ({
  productId,
  field,
  original: 'x',
  suggestion,
});

describe('EnrichSpellPhase: ortografia conferida pelo serviço real', () => {
  it('correção do filé: sugestão com o nome corrigido; o item sem erro fica sem sugestão', async () => {
    const { phase, create } = build();
    create.mockResolvedValue(
      answer({ corrections: [correction('file', 'FILÉ DE TILÁPIA CONGELADO')] }),
    );

    const verdicts = await phase.run([file, abacate], callContext());

    expect(verdicts).toEqual([
      { itemId: 'file', action: 'suggest', value: 'FILÉ DE TILÁPIA CONGELADO' },
      { itemId: 'abacate', action: 'clean' },
    ]);
  });

  it('sugestão que não serve (igual ao nome, só espaços, 130 caracteres): os três ficam sem sugestão', async () => {
    const { phase, create } = build();
    const [a, b, c] = ['um', 'dois', 'tres'].map((id) => itemInput(`NOME ${id}`, { id }));
    create.mockResolvedValue(
      answer({
        corrections: [
          correction('um', 'NOME um'),
          correction('dois', '    '),
          correction('tres', 'X'.repeat(130)),
        ],
      }),
    );

    const verdicts = await phase.run([a, b, c], callContext());

    expect(verdicts.map((v) => v.action)).toEqual(['clean', 'clean', 'clean']);
  });

  it('só o id e o nome vão ao serviço, sem observation nem badgeText', async () => {
    const { phase, create, service } = build();
    create.mockResolvedValue(answer());
    const spellCheck = jest.spyOn(service, 'spellCheck');

    await phase.run([file], callContext());

    expect(spellCheck.mock.calls[0][0]).toEqual([
      { id: 'file', name: 'FILE DE TILAPIA CONJELADO' },
    ]);
    const sent = JSON.parse(
      create.mock.calls[0][0].messages[1].content.replace(/^[^[]*/, ''),
    ) as Array<{ field: string }>;
    expect(sent.map((entry) => entry.field)).toEqual(['name']);
  });

  it('repassa o coletor de uso e o sinal: o uso da chamada fica no coletor', async () => {
    const { phase, create } = build();
    create.mockResolvedValue(
      chatResponse({
        content: JSON.stringify({ corrections: [] }),
        usage: { prompt_tokens: 500, completion_tokens: 50 },
      }),
    );
    const context = callContext();

    await phase.run([file], context);

    expect(create.mock.calls[0][1].signal).toBe(context.signal);
    expect(context.usage.snapshot()).toMatchObject({ model: 'gpt-6-luna', calls: 1 });
  });
});

describe('EnrichSpellPhase: disponibilidade', () => {
  it('AI_SPELLCHECK_ENABLED=false com a chave presente: indisponível', () => {
    expect(build({ AI_SPELLCHECK_ENABLED: 'false' }).phase.isAvailable()).toBe(false);
  });

  it('sem chave: indisponível, sem chamar a OpenAI', () => {
    const service = new SpellCheckService(fakeConfig({ OPENAI_API_KEY: '' }));
    expect(new EnrichSpellPhase(service).isAvailable()).toBe(false);
  });

  it('chave e flag: disponível', () => {
    expect(build().phase.isAvailable()).toBe(true);
  });
});

describe('EnrichSpellPhase: falha do serviço', () => {
  it('chave inválida (401): terminal, sem repetir', async () => {
    const { phase, create } = build();
    create.mockRejectedValue(openAiError(401, 'chave inválida'));

    const error = await phase.run([file], callContext()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('uma das chamadas paralelas falha (40 nomes, a terceira responde 503): o lote falha, nenhum veredito', async () => {
    const { phase, create } = build();
    const items = Array.from({ length: 40 }, (_, index) =>
      itemInput(`PRODUTO ${index}`, { id: `p-${index}` }),
    );
    let call = 0;
    create.mockImplementation(async () => {
      call += 1;
      if (call === 3) throw openAiError(503, 'indisponível');
      return answer();
    });
    const context = callContext();

    await expect(phase.run(items, context)).rejects.toBeInstanceOf(TransientProviderError);

    expect(create).toHaveBeenCalledTimes(4);
  });

  it('o uso das chamadas já concluídas fica no coletor mesmo com a falha de outra', async () => {
    const { phase, create } = build();
    const items = Array.from({ length: 40 }, (_, index) =>
      itemInput(`PRODUTO ${index}`, { id: `p-${index}` }),
    );
    let call = 0;
    create.mockImplementation(async () => {
      call += 1;
      if (call === 4) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw openAiError(503, 'indisponível');
      }
      return chatResponse({
        content: JSON.stringify({ corrections: [] }),
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
    });
    const context = callContext();

    await expect(phase.run(items, context)).rejects.toBeInstanceOf(TransientProviderError);

    expect(context.usage.snapshot().calls).toBe(3);
  });
});
