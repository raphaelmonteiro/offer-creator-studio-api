import { SCENE_FAILURE_CODES } from './domain/scene.types';
import { failureReply } from './scene-texts';

describe('scene-texts', () => {
  it.each(SCENE_FAILURE_CODES)('há mensagem em pt-BR para %s', (code) => {
    const reply = failureReply(code);
    expect(reply.length).toBeGreaterThan(10);
    expect(reply).not.toContain(code);
  });

  it('a falta de saldo pede para avisar o administrador', () => {
    expect(failureReply('PROVIDER_QUOTA')).toContain('sem saldo');
    expect(failureReply('PROVIDER_QUOTA')).toContain('administrador');
  });

  it('a política de conteúdo pede outra descrição', () => {
    expect(failureReply('PROVIDER_CONTENT_POLICY')).toContain('Descreva a cena de outro jeito');
  });
});
