import { isHttpProtocol } from './is-http-protocol';

describe('isHttpProtocol', () => {
  it.each(['http:', 'https:'])('%s serve', (protocol) => {
    expect(isHttpProtocol(protocol)).toBe(true);
  });

  it.each(['ftp:', 'data:', 'file:', 'javascript:', 'http', 'HTTP:', ''])(
    '%j não serve',
    (protocol) => {
      expect(isHttpProtocol(protocol)).toBe(false);
    },
  );
});
