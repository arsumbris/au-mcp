import { describe, it, expect } from 'vitest'
import { checkToolInput } from '../src/daemon/validate.ts'
import type { EngineBroker, EngineFrame } from '../src/daemon/broker.ts'

type Diag = { code?: string; severity?: string; message?: string }
type Verdict = { identity: { name?: string; repo?: string; hash?: string } | null; diagnostics?: Diag[] }

/** A resolved-identity verdict (the def was found), carrying `diags`. */
const fit = (diags: Diag[]): Verdict => ({ identity: { name: 'mcp.tool.t', repo: 'au-mcp', hash: 'h' }, diagnostics: diags })
/** A null-identity verdict (the type name did not resolve — owner unmounted). */
const unresolved = (diags: Diag[]): Verdict => ({ identity: null, diagnostics: diags })

/** A fake broker returning the given schema-17 validate_value verdict array. */
function brokerReturning(result: Verdict[], available = true): EngineBroker {
  return {
    socketPath: '/fake/daemon.sock',
    mutate: async () => ({}),
    available: () => available,
    async read(): Promise<EngineFrame> {
      return { type: 'ok', ready: true, result }
    },
  }
}

describe('checkToolInput', () => {
  it('blocks a genuine input error (missing required field)', async () => {
    const broker = brokerReturning([fit([{ code: 'required-field-absent', severity: 'error', message: 'field "command" is required' }])])
    const msg = await checkToolInput(broker, 'mcp.bash', {})
    expect(msg).not.toBeNull()
    expect(msg).toContain('required-field-absent')
  })

  it('proceeds when the value conforms (a resolved verdict, no diagnostics)', async () => {
    const broker = brokerReturning([fit([])])
    expect(await checkToolInput(broker, 'mcp.bash', { command: 'echo hi' })).toBeNull()
  })

  // An input mapping that happens to carry a `type` KEY collides with the engine's synthetic
  // type-claim -> `duplicate-key-in-mapping`, on a RESOLVED verdict. An engine-mechanism limit,
  // not bad input, so the invoke must NOT be refused. (No tool declares a `type` field anymore —
  // those were renamed since `type` is reserved — but an agent can still pass a stray `type` key,
  // and a tool's data field can hold one, so the defense stays.)
  it('does not block on duplicate-key-in-mapping when the identity resolved (a stray type key rides as data)', async () => {
    const broker = brokerReturning([fit([{ code: 'duplicate-key-in-mapping', severity: 'error', message: 'duplicate key "type"' }])])
    expect(await checkToolInput(broker, 'mcp.au_instances_of', { ofType: 'session-log', type: 'session-log' })).toBeNull()
  })

  // The probe-verified subtlety: an input carrying `type: "plan"` makes the engine read that
  // value as a type claim -> `unknown-type-claim`, but the IDENTITY still resolved. A synthesis
  // artifact about the data, NOT the tool def missing, so it must NOT block. (Blindly blocking
  // every unknown-type-claim would refuse any invoke whose input carries a stray `type` key.)
  it('does not block unknown-type-claim when the identity resolved (input carries a stray type key)', async () => {
    const broker = brokerReturning([fit([{ code: 'unknown-type-claim', severity: 'error', message: "type-def 'plan' is not present" }])])
    expect(await checkToolInput(broker, 'mcp.au_instances_of', { ofType: 'plan', type: 'plan' })).toBeNull()
  })

  // FAIL-CLOSED (schema 17): a NULL-identity verdict means the tool def itself did not
  // resolve — au-mcp is not mounted, the type graph is unreliable — so refuse.
  it('BLOCKS when the def does not resolve (null-identity verdict, fail-closed)', async () => {
    const broker = brokerReturning([unresolved([{ code: 'unknown-type-claim', severity: 'error', message: 'not in the type graph' }])])
    const msg = await checkToolInput(broker, 'mcp.bash', { command: 'x' })
    expect(msg).not.toBeNull()
    expect(msg).toContain('unknown-type-claim')
    // Uniform B1-A phrasing, shared with the invoke path's unregistered-callable result.
    expect(msg).toMatch(/referenced but not mounted/i)
  })

  it('proceeds when no engine is available (a transport gap, not a type gap)', async () => {
    const broker = brokerReturning([fit([{ code: 'required-field-absent', severity: 'error' }])], false)
    expect(await checkToolInput(broker, 'mcp.bash', {})).toBeNull()
  })

  it('scopes validation to the tool OWNER repo (provenance), not hardcoded au-mcp', async () => {
    let seenRepo: unknown
    const broker: EngineBroker = {
      socketPath: '/x',
      mutate: async () => ({}),
      available: () => true,
      async read(_op, args): Promise<EngineFrame> {
        seenRepo = (args as { repo?: unknown })?.repo
        return { type: 'ok', ready: true, result: [fit([])] }
      },
    }
    // a CONTRIBUTED tool resolves in its owning package, not au-mcp (todo 2606231443).
    await checkToolInput(broker, 'mcp.au_guide', {}, 'au-mcp-type-knowledge')
    expect(seenRepo).toBe('au-mcp-type-knowledge')
    // a CORE tool ('core' provenance) resolves in au-mcp.
    await checkToolInput(broker, 'mcp.read_file_pinned', {}, 'core')
    expect(seenRepo).toBe('au-mcp')
    // no provenance falls back to au-mcp.
    await checkToolInput(broker, 'mcp.read_file_pinned', {})
    expect(seenRepo).toBe('au-mcp')
  })
})
