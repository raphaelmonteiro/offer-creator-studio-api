import { readStructureAiConfig } from '../config/structure-ai.config';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { createStructureAiPort } from './flyer-pro-structure-ai.factory';
import { MockFlyerProStructureAi } from './flyer-pro-structure-ai.mock';

const portFor = (provider: string) => {
  const warn = jest.fn();
  const config = readStructureAiConfig(fakeConfig({ FLYER_PRO_STRUCTURE_AI_PROVIDER: provider }), {
    warn,
  });
  return { port: createStructureAiPort(config), warn };
};

describe('createStructureAiPort', () => {
  it('mock devolve o provedor simulado', () => {
    const { port, warn } = portFor('mock');
    expect(port).toBeInstanceOf(MockFlyerProStructureAi);
    expect(port.source).toBe('mock');
    expect(warn).not.toHaveBeenCalled();
  });

  it('valor desconhecido cai no simulado, com um aviso que traz o valor recebido', () => {
    const { port, warn } = portFor('openai');
    expect(port.source).toBe('mock');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"openai"');
  });
});
