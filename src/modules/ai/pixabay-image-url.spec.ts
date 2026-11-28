import { isPixabayImageUrl } from './pixabay-image-url';

describe('isPixabayImageUrl', () => {
  it.each([
    'https://pixabay.com/get/g1a2b3c4d5e6f_1280.jpg',
    'https://cdn.pixabay.com/photo/2020/01/01/10/00/abacate-1234_150.jpg',
    'https://PIXABAY.com/get/x.jpg',
    'https://pixabay.com:443/get/x.jpg',
  ])('aceita %s', (url) => {
    expect(isPixabayImageUrl(new URL(url))).toBe(true);
  });

  it.each([
    'https://exemplo.com/x.jpg',
    'https://pixabay.com.exemplo.com/x.jpg',
    'https://exemplopixabay.com/x.jpg',
    'https://sub.pixabay.com/x.jpg',
    'https://pixabay.com@exemplo.com/x.jpg',
    'http://pixabay.com/get/x.jpg',
    'ftp://pixabay.com/x.jpg',
    'https://pixabay.com:8443/get/g1a2b3c4d5e6f_1280.jpg',
    'https://cdn.pixabay.com:8080/x.jpg',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:3001/v1/health',
  ])('recusa %s', (url) => {
    expect(isPixabayImageUrl(new URL(url))).toBe(false);
  });
});
