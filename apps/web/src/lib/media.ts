'use client'

/**
 * Presentation helpers for thread media: MIME-enum labels, byte counts, and
 * BlurHash placeholders. Pure rendering — nothing here touches the network.
 */

import { ENUM_TO_MIME } from '@fairhaven/board-core'
import { decode as decodeBlurhash } from 'blurhash'

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'comic' | 'comic-rar' | 'file'

const MIME_BY_LABEL: Record<string, string> = {
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/svg+xml': 'image',
  'text/plain': 'text',
  'text/markdown': 'text',
  'application/pdf': 'pdf',
  'application/vnd.comicbook+zip': 'comic',
  'application/vnd.comicbook-rar': 'comic-rar',
}

/** Rendering bucket for a shared Haven MIME enum value. */
export function mimeKind(mime: number): MediaKind {
  const label = ENUM_TO_MIME[mime]
  if (!label) return 'file'
  return (MIME_BY_LABEL[label] ?? 'file') as MediaKind
}

/** Human label for a MIME enum value, e.g. `image/png`. Empty when unknown. */
export function mimeLabel(mime: number): string {
  return ENUM_TO_MIME[mime] ?? ''
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`
}

/** Decode a BlurHash hint into a small data-URL placeholder image. */
export function blurhashDataUrl(hash: string, w = 32, h = 32): string | undefined {
  try {
    const px = decodeBlurhash(hash, w, h)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const img = ctx.createImageData(w, h)
    img.data.set(px)
    ctx.putImageData(img, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return undefined
  }
}
