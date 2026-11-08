import { layer } from '../testing/scene-template-fixtures';
import { canonicalJson, PROJECTION_VERSION, projectionKeys } from './scene-template-keys';

const base = { formatId: 'folheto-27x54', name: 'Páscoa', masterAssetId: 'master-1' };
const generated = layer({ id: 'g', kind: 'generated', assetId: 'a1', z: 1 });
const logo = layer({ id: 'l', kind: 'logo', assetId: 'a2', z: 2 });
const text = layer({ id: 't', text: 'Oi', z: 3 });

describe('impressões digitais da projeção (PV-12)', () => {
  it('canonicalJson ignora a ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
  });

  it('a mesma cena dá as mesmas chaves, e a ordem dos elementos não importa', () => {
    const one = projectionKeys({ ...base, elements: [generated, logo, text] });
    const two = projectionKeys({ ...base, elements: [text, logo, generated] });
    expect(two).toEqual(one);
    expect(PROJECTION_VERSION).toBe(1);
  });

  it('mover a logo ou trocar o texto muda só a impressão digital, não a chave pictórica', () => {
    const before = projectionKeys({ ...base, elements: [generated, logo, text] });
    const moved = projectionKeys({ ...base, elements: [generated, { ...logo, x: 0.9 }, text] });
    const edited = projectionKeys({
      ...base,
      elements: [generated, logo, { ...text, text: 'Tchau' }],
    });
    expect(moved.pictorialKey).toBe(before.pictorialKey);
    expect(moved.fingerprint).not.toBe(before.fingerprint);
    expect(edited.pictorialKey).toBe(before.pictorialKey);
    expect(edited.fingerprint).not.toBe(before.fingerprint);
  });

  it('master, elemento achatado e formato mudam a chave pictórica', () => {
    const before = projectionKeys({ ...base, elements: [generated] });
    expect(
      projectionKeys({ ...base, masterAssetId: 'master-2', elements: [generated] }).pictorialKey,
    ).not.toBe(before.pictorialKey);
    expect(projectionKeys({ ...base, elements: [{ ...generated, w: 0.9 }] }).pictorialKey).not.toBe(
      before.pictorialKey,
    );
    expect(
      projectionKeys({ ...base, formatId: 'folheto-27x40', elements: [generated] }).pictorialKey,
    ).not.toBe(before.pictorialKey);
  });

  it('o nome da cena muda a impressão digital e não a chave pictórica', () => {
    const before = projectionKeys({ ...base, elements: [] });
    const renamed = projectionKeys({ ...base, name: 'Natal', elements: [] });
    expect(renamed.pictorialKey).toBe(before.pictorialKey);
    expect(renamed.fingerprint).not.toBe(before.fingerprint);
  });
});
