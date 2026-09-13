import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readViewAccessors, type ReadViewSession } from '../src/daemon/daemon.ts'

// The plugin-facing read-view accessors placed on MediationContext (Phase 4, G1). These lock the
// exact wiring a mediator receives — the two floors' distinct semantics:
//  - hasRead  = canonicalized union of read-view ∪ served-view  (tool-precondition's input)
//  - readHash = exact read-view lookup, no realpath, no served-view  (read-guard's staleness input)

const session = (readView: Record<string, string>, servedView: Record<string, string> = {}): ReadViewSession => ({
  readView: new Map(Object.entries(readView)),
  servedView: new Map(Object.entries(servedView)),
})

describe('readViewAccessors', () => {
  describe('readHash — exact read-time hash, read-view only', () => {
    it('returns the recorded hash for a read path', () => {
      const { readHash } = readViewAccessors(session({ '/abs/a.md': 'h1' }))
      expect(readHash('/abs/a.md')).toBe('h1')
    })

    it('returns undefined for a path the session never read', () => {
      const { readHash } = readViewAccessors(session({ '/abs/a.md': 'h1' }))
      expect(readHash('/abs/other.md')).toBeUndefined()
    })

    it('does NOT consult the served-view (a served-only path has no read-time hash)', () => {
      const { readHash } = readViewAccessors(session({}, { '/abs/served.md': 'hs' }))
      expect(readHash('/abs/served.md')).toBeUndefined()
    })

    it('is exact-path — it does not canonicalize (mirrors read-guard write file_path == read path)', () => {
      // a symlink whose target is in the read-view is NOT matched by readHash (no realpath).
      const dir = mkdtempSync(join(tmpdir(), 'au-rv-'))
      const real = join(dir, 'real.md')
      const link = join(dir, 'link.md')
      writeFileSync(real, 'x')
      symlinkSync(real, link)
      const { readHash } = readViewAccessors(session({ [real]: 'h1' }))
      expect(readHash(real)).toBe('h1')
      expect(readHash(link)).toBeUndefined() // exact-path, no symlink resolution
    })
  })

  describe('hasRead — canonicalized union of read-view and served-view', () => {
    it('is true for a read path and a served path, false otherwise', () => {
      const { hasRead } = readViewAccessors(session({ '/abs/read.md': 'h1' }, { '/abs/served.md': 'hs' }))
      expect(hasRead('/abs/read.md')).toBe(true)
      expect(hasRead('/abs/served.md')).toBe(true)
      expect(hasRead('/abs/unknown.md')).toBe(false)
    })

    it('canonicalizes (realpath) both sides, so a symlink matches its target', () => {
      const dir = mkdtempSync(join(tmpdir(), 'au-rv-'))
      const real = join(dir, 'guide.md')
      const link = join(dir, 'guide-link.md')
      writeFileSync(real, 'x')
      symlinkSync(real, link)
      // served-view stores the canonical (real) path; a query via the symlink still matches.
      const { hasRead } = readViewAccessors(session({}, { [realpathSync(real)]: 'hs' }))
      expect(hasRead(link)).toBe(true)
    })
  })
})
