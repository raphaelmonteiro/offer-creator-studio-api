import { ConfigService } from '@nestjs/config';
import { TemplateElementAssistantService } from './template-element-assistant.service';
import { TemplateGenerateService } from './template-generate.service';
import { TemplateImageGeneratorService } from './template-image-generator.service';
import { TemplateLayersGeneratorService } from './template-layers-generator.service';
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

/** Serviço de template que também gera imagem: o provedor de imagem e o envio ao disco simulados (sem chamada real). */
function withImageFakes<T extends object>(
  Service: new (config: ConfigService, uploads: never, images: never) => T,
  env: Record<string, string>,
) {
  const images = {
    editImage: jest.fn().mockResolvedValue(GENERATED_IMAGE),
    generateImage: jest.fn().mockResolvedValue(GENERATED_IMAGE),
  };
  const uploads = { uploadFile: jest.fn().mockResolvedValue({ url: '/uploads/templates/x.png' }) };
  const built = withFakes(
    (vars) => new Service(fakeConfig(vars), uploads as never, images as never),
    env,
  );
  return { ...built, images, uploads };
}

/** Gerar template com o provedor de imagem e o disco simulados (o placeholder `GENERATE:` chega a `generateImage`). */
export function buildTemplateGenerateWithImages(env: Record<string, string> = {}) {
  return withImageFakes(TemplateGenerateService, env);
}

/** Assistente de elemento com o provedor de imagem e o disco simulados. */
export function buildTemplateElementWithImages(env: Record<string, string> = {}) {
  return withImageFakes(TemplateElementAssistantService, env);
}

export function buildTemplateImage(env: Record<string, string> = {}) {
  return withImageFakes(TemplateImageGeneratorService, env);
}

export function buildTemplateLayers(env: Record<string, string> = {}) {
  return withImageFakes(TemplateLayersGeneratorService, env);
}

const GENERATED_IMAGE = {
  image: { buffer: Buffer.from('png'), mimeType: 'image/png', extension: '.png' },
};

/** Intenção que o provedor devolve: imagem nova inteira, com confiança alta. */
export const INTENT_ANSWER = chatResponse({
  content: JSON.stringify({ category: 'new_full_image', confidence: 0.9, reason: 'pedido novo' }),
});

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

/** Configuração cujo fundo do cabeçalho é um placeholder `GENERATE:`, que o serviço troca por uma imagem gerada. */
export const PLACEHOLDER_ANSWER = chatResponse({
  content: JSON.stringify({
    assistantMessage: 'Pronto',
    configuration: {
      header: {
        ...section('header'),
        background: { type: 'image', url: 'GENERATE: maçã vermelha' },
      },
      footer: section('footer'),
    },
  }),
});

export const ACTIONS_ANSWER = chatResponse({
  content: JSON.stringify({ assistantMessage: 'Feito', actions: [] }),
});

/** Composição do template em camadas sem elementos: só o fundo é gerado. */
export const COMPOSITION_ANSWER = chatResponse({
  content: JSON.stringify({
    palette: { primary: '#0044cc', secondary: '#ffcc00', dark: '#001133', light: '#ffffff' },
    backgroundPrompt: 'blue gradient',
    elements: [],
    bodyBackground: { type: 'solid', color: '#ffffff' },
    footerBackground: { type: 'solid', color: '#001133' },
    assistantMessagePt: 'Camadas prontas',
  }),
});
