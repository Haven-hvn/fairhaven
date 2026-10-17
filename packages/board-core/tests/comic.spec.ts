import { describe, expect, it } from 'vitest'
import { isComicPage, naturalCompare, orderComicPages, pageMime, sniffArchive } from '../src/comic.ts'
import { MIME_CBR, MIME_CBZ, MIME_TO_ENUM, ENUM_TO_MIME } from '../src/constants.ts'

describe('comic archives', () => {
  it('orders pages naturally and drops junk', () => {
    const names = ['ch1/p10.jpg', 'ch1/p2.JPG', 'ch1/p1.png', '__MACOSX/._p1.png', 'ComicInfo.xml', 'ch1/', 'cover.webp', 'ch2/p1.jpg', '.hidden.jpg', 'Thumbs.db']
    expect(orderComicPages(names)).toEqual(['ch1/p1.png', 'ch1/p2.JPG', 'ch1/p10.jpg', 'ch2/p1.jpg', 'cover.webp'])
  })
  it('natural compare handles digits vs text and zero padding', () => {
    expect(naturalCompare('p2.jpg', 'p10.jpg')).toBeLessThan(0)
    expect(naturalCompare('p02.jpg', 'p2.jpg')).toBeGreaterThan(0)
    expect(naturalCompare('a.jpg', 'b.jpg')).toBeLessThan(0)
    expect(naturalCompare('x.jpg', 'x.jpg')).toBe(0)
  })
  it('page detection and mime', () => {
    expect(isComicPage('a/b/c.jpeg')).toBe(true)
    expect(isComicPage('a/b/')).toBe(false)
    expect(isComicPage('readme.txt')).toBe(false)
    expect(pageMime('x.PNG')).toBe('image/png')
    expect(pageMime('x.jpg')).toBe('image/jpeg')
  })
  it('sniffs containers', () => {
    expect(sniffArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('zip')
    expect(sniffArchive(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))).toBe('rar')
    expect(sniffArchive(new Uint8Array([1, 2, 3]))).toBe('unknown')
  })
  it('enum appended, never renumbered', () => {
    expect(MIME_TO_ENUM['application/pdf']).toBe(14)
    expect(MIME_TO_ENUM['application/vnd.comicbook+zip']).toBe(MIME_CBZ)
    expect(MIME_TO_ENUM['application/vnd.comicbook-rar']).toBe(MIME_CBR)
    expect(ENUM_TO_MIME[15]).toBe('application/vnd.comicbook+zip')
  })
})
