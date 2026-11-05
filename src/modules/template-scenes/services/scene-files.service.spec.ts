import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SceneFilesService } from './scene-files.service';

const SCENE = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';

describe('SceneFilesService', () => {
  let dir: string;
  let service: SceneFilesService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-files-'));
    service = new SceneFilesService(new ConfigService({ UPLOAD_DEST: dir }));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('grava em uploads/template-scenes/<cena>/<versão>/ e devolve URL relativa', async () => {
    const written = await service.write(SCENE, VERSION, 'master.png', Buffer.from('abc'));
    expect(written).toEqual({
      url: `/uploads/template-scenes/${SCENE}/${VERSION}/master.png`,
      bytes: 3,
    });
    const disk = await fs.readFile(path.join(dir, 'template-scenes', SCENE, VERSION, 'master.png'));
    expect(disk.toString()).toBe('abc');
  });

  it('não deixa arquivo temporário para trás', async () => {
    await service.write(SCENE, VERSION, 'preview.webp', Buffer.from('x'));
    const files = await fs.readdir(path.join(dir, 'template-scenes', SCENE, VERSION));
    expect(files).toEqual(['preview.webp']);
  });

  it.each([['../escape.png'], ['a/b.png'], ['.oculto'], [''], ['x'.repeat(101)]])(
    'recusa o nome de arquivo %p',
    async (filename) => {
      await expect(service.write(SCENE, VERSION, filename, Buffer.from('x'))).rejects.toThrow(
        'inválido',
      );
    },
  );

  it('recusa ids que não são uuid (sem escapar da pasta)', async () => {
    await expect(service.write('../..', VERSION, 'a.png', Buffer.from('x'))).rejects.toThrow(
      'inválido',
    );
    await expect(service.write(SCENE, 'abc', 'a.png', Buffer.from('x'))).rejects.toThrow(
      'inválido',
    );
  });

  it('só resolve URLs sob /uploads/template-scenes/', () => {
    expect(() => service.absolutePath('/uploads/products/a.png')).toThrow();
    expect(() => service.absolutePath('/uploads/template-scenes/../products/a.png')).toThrow();
    expect(service.absolutePath(`/uploads/template-scenes/${SCENE}/${VERSION}/a.png`)).toBe(
      path.join(dir, 'template-scenes', SCENE, VERSION, 'a.png'),
    );
  });

  it('remove o arquivo e ignora o que não existe', async () => {
    const { url } = await service.write(SCENE, VERSION, 'a.png', Buffer.from('x'));
    await service.remove(url);
    await expect(fs.access(service.absolutePath(url))).rejects.toThrow();
    await expect(service.remove(url)).resolves.toBeUndefined();
  });
});
