import * as os from 'os';
import * as path from 'path';
import { bootCwd, pinUploadsDirEnv, resolveAppPath, resolveUploadsDir } from './uploads-dir';

describe('uploads-dir', () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it('ancora valor relativo no cwd do boot', () => {
    expect(resolveUploadsDir('./uploads')).toBe(path.join(bootCwd(), 'uploads'));
    expect(resolveUploadsDir('uploads')).toBe(path.join(bootCwd(), 'uploads'));
  });

  it('mantém valor absoluto intacto', () => {
    expect(resolveUploadsDir('/srv/uploads')).toBe('/srv/uploads');
  });

  it.each([undefined, null, '', '   '])('usa ./uploads quando o valor é %p', (value) => {
    expect(resolveUploadsDir(value)).toBe(path.join(bootCwd(), 'uploads'));
  });

  it('não muda quando o cwd muda depois do carregamento', () => {
    const before = resolveUploadsDir('./uploads');
    process.chdir(os.tmpdir());
    expect(resolveUploadsDir('./uploads')).toBe(before);
    expect(resolveAppPath('x')).toBe(path.join(bootCwd(), 'x'));
  });

  it('pinUploadsDirEnv normaliza a variável e é idempotente', () => {
    const env: NodeJS.ProcessEnv = { UPLOAD_DEST: './data' };
    const first = pinUploadsDirEnv(env);
    expect(first).toBe(path.join(bootCwd(), 'data'));
    expect(env.UPLOAD_DEST).toBe(first);
    expect(pinUploadsDirEnv(env)).toBe(first);
    expect(pinUploadsDirEnv({})).toBe(path.join(bootCwd(), 'uploads'));
  });

  it('módulo carregado antes do chdir usa o cwd antigo', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const helper = require('./uploads-dir') as typeof import('./uploads-dir');
      const boot = process.cwd();
      process.chdir(os.tmpdir());
      expect(helper.resolveUploadsDir('./uploads')).toBe(path.join(boot, 'uploads'));
    });
  });
});
