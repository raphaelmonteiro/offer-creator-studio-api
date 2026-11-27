import { TemplateElementAssistantService } from './template-element-assistant.service';
import { TemplateGenerateService } from './template-generate.service';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  spyOnLogger,
} from './utils/openai-chat.testutil';

/** Apoio dos testes dos serviços de template que falam com o chat: serviço real, cliente da OpenAI simulado. */
function withFakes<T extends object>(
  make: (env: Record<string, string>) => T,
  env: Record<string, string>,
) {
  const service = make({ OPENAI_API_KEY: 'sk-teste', ...env });
  return { service, create: installFakeOpenAi(service), logs: spyOnLogger(service) };
}

export function buildTemplateGenerate(env: Record<string, string> = {}) {
  return withFakes(
    (vars) => new TemplateGenerateService(fakeConfig(vars), {} as never, {} as never),
    env,
  );
}

export function buildTemplateElement(env: Record<string, string> = {}) {
  return withFakes(
    (vars) => new TemplateElementAssistantService(fakeConfig(vars), {} as never, {} as never),
    env,
  );
}

export const FORMAT = {
  type: 'folheto-20x27',
  artWidthCm: 20.5,
  artHeightCm: 27.5,
  headerHeightCm: 6,
  footerHeightCm: 4,
};

export const USER_MESSAGES = [{ role: 'user' as const, content: 'Fundo azul com ofertas' }];

/** Seção mínima que passa na validação da configuração do template. */
const section = (id: string) => ({
  id,
  name: id,
  widthCm: 20.5,
  heightCm: 6,
  background: { type: 'solid', color: '#ffffff' },
  elements: [],
});

export const CONFIGURATION_ANSWER = chatResponse({
  content: JSON.stringify({
    assistantMessage: 'Pronto',
    configuration: { header: section('header'), footer: section('footer') },
  }),
});

export const ACTIONS_ANSWER = chatResponse({
  content: JSON.stringify({ assistantMessage: 'Feito', actions: [] }),
});
