import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { readStructureAiConfig } from '../config/structure-ai.config';
import { createStructureAiPort } from './flyer-pro-structure-ai.factory';
import { MockFlyerProStructureAi } from './flyer-pro-structure-ai.mock';
import { RealFlyerProStructureAi } from './flyer-pro-structure-ai.real';

/** O provedor que a fábrica escolhe para o `PROVIDER` e a chave dados, com os avisos da configuração e da fábrica. */
const portFor = (provider: string | undefined, env: Record<string, string> = {}) => {
  const warn = jest.fn();
  const values = {
    ...(provider === undefined ? {} : { FLYER_PRO_STRUCTURE_AI_PROVIDER: provider }),
    ...env,
  };
  const config = fakeConfig(values);
  const port = createStructureAiPort(readStructureAiConfig(config, { warn }), config, { warn });
  return { port, warnings: warn.mock.calls.map(([line]) => String(line)) };
};

describe('createStructureAiPort', () => {
  it('mock devolve o provedor simulado, com ou sem chave, sem aviso', () => {
    for (const env of [{}, { OPENAI_API_KEY: 'sk-teste' }]) {
      const { port, warnings } = portFor('mock', env);
      expect(port).toBeInstanceOf(MockFlyerProStructureAi);
      expect(warnings).toEqual([]);
    }
  });

  it('valor desconhecido cai no simulado, com um aviso que traz o valor recebido', () => {
    const { port, warnings } = portFor('openai');
    expect(port.source).toBe('mock');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"openai"');
  });

  it('real (o padrão) com chave devolve o provedor real disponível, sem aviso', () => {
    for (const provider of ['real', undefined]) {
      const { port, warnings } = portFor(provider, { OPENAI_API_KEY: 'sk-teste' });
      expect(port).toBeInstanceOf(RealFlyerProStructureAi);
      expect(port.unavailableReason()).toBeNull();
      expect(warnings).toEqual([]);
    }
  });

  it('real sem chave não falha ao subir: devolve o provedor, com um aviso, e ele responde NO_API_KEY', () => {
    const { port, warnings } = portFor('real');
    expect(port).toBeInstanceOf(RealFlyerProStructureAi);
    expect(port.source).toBe('ai');
    expect(port.unavailableReason()).toBe('NO_API_KEY');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OPENAI_API_KEY');
  });

  it('o aviso nunca traz a chave', () => {
    const { warnings } = portFor('real', { OPENAI_API_KEY: '' });
    expect(warnings.join(' ')).not.toMatch(/sk-/);
  });
});
