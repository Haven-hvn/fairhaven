import { describe, expect, it } from 'vitest'
import type { RawEntity } from '@fairhaven/board-core'
import { isBoardRow, keyTouchesThread, openThreadOf, rowsIncludeDef, rowsTouchThread } from '../src/lib/watch'

/**
 * Regression: the chain-wide entity watch fetched payloads for every Arkiv
 * event (~1/s on Tiramisu, almost none of them board posts) and then
 * reloaded `['thread']` / `['boards']` unconditionally. Only a fetched
 * board definition may reload the directory, and only a row touching the
 * open thread may reload it.
 */
const keyA = `0x${'a'.repeat(64)}`
const keyB = `0x${'b'.repeat(64)}`
const foreignKey = `0x${'f'.repeat(64)}`

function row(key: string, grp: string, rootRef?: string): RawEntity {
  return { key, owner: `0x${'1'.repeat(40)}`, createdAt: 1, attributes: { grp, ...(rootRef ? { root_ref: rootRef } : {}) } }
}

const open = [openThreadOf({ root: { key: keyA }, replies: [{ key: keyB }] })!]

describe('watch relevance', () => {
  it('recognises board rows and ignores foreign entities', () => {
    expect(isBoardRow(row(keyA, 'haven.board.thread'))).toBe(true)
    expect(isBoardRow(row(keyA, 'haven.board.def'))).toBe(true)
    expect(isBoardRow(row(keyA, 'haven.video.full'))).toBe(true)
    expect(isBoardRow(row(foreignKey, 'haven.storage.file'))).toBe(false)
    expect(isBoardRow({ key: foreignKey, owner: `0x${'1'.repeat(40)}`, createdAt: 1, attributes: {} })).toBe(false)
  })

  it('reloads the board directory only for a fetched definition', () => {
    expect(rowsIncludeDef([row(foreignKey, 'haven.storage.file'), row(keyA, 'haven.board.thread')])).toBe(false)
    expect(rowsIncludeDef([row(keyA, 'haven.board.def')])).toBe(true)
  })

  it('reloads the open thread only for its root, replies, or new replies to it', () => {
    expect(rowsTouchThread([row(keyA, 'haven.board.thread')], open)).toBe(true)
    expect(rowsTouchThread([row(keyB, 'haven.board.post', keyA)], open)).toBe(true)
    // A brand-new comment on the open thread is not a cached key yet.
    expect(rowsTouchThread([row(foreignKey, 'haven.board.post', keyA)], open)).toBe(true)
    expect(rowsTouchThread([row(foreignKey, 'haven.board.post', keyB)], open)).toBe(false)
    expect(rowsTouchThread([row(foreignKey, 'haven.board.thread')], open)).toBe(false)
    expect(keyTouchesThread(keyB, open)).toBe(true)
    expect(keyTouchesThread(foreignKey, open)).toBe(false)
  })

  it('touches nothing when no thread is open', () => {
    expect(rowsTouchThread([row(keyA, 'haven.board.thread')], [])).toBe(false)
    expect(openThreadOf(null)).toBeUndefined()
    expect(openThreadOf(undefined)).toBeUndefined()
  })
})
