// The kernel's human-approval surface for a mediator `requestApproval`.
//
// A governance mediator (e.g. au-workflow's escape gate) needs a HUMAN verdict it can LEARN —
// something CC's native `ask` prompt cannot give (CC exposes no permission outcome to any hook,
// verified 2608042010). So the daemon runs its OWN prompt and returns the answer. The daemon is
// local-first (on the human's machine), so a native macOS dialog reaches the human directly.
//
// BLOCKS until a button is clicked. No timeout: an unanswered escape must never proceed —
// blocking IS the fail-closed. Only an explicit "Approve" grants; anything else (a Deny click,
// an osascript error, a dismissed dialog) is a DENY.
//
// Injectable (DaemonOptions.approval) so tests never spawn a real dialog. The menubar-app
// surface (decision 2608041956, option 2) is the cross-platform upgrade path if ever needed.

import { spawn } from 'node:child_process'
import type { ApprovalRequest, ApprovalVerdict } from '@arsumbris/au-mcp-sdk'

/** Prompt a human and resolve with their verdict. One impl per surface (osascript, test fake). */
export type ApprovalPrompt = (req: ApprovalRequest, sessionId: string) => Promise<ApprovalVerdict>

/** Build the dialog body: the reason, then the facts that let the human locate the chat. */
function dialogBody(req: ApprovalRequest, sessionId: string): string {
  return [
    req.reason,
    '',
    `session: ${sessionId}`,
    ...(req.tool ? [`tool: ${req.tool}`] : []),
    ...(req.inputSummary ? [`input: ${req.inputSummary}`] : []),
    '',
    'Look at the chat for full context, then choose.',
  ].join('\n')
}

/**
 * Native macOS approval dialog. Text is passed as AppleScript `argv` (never interpolated into
 * the script), so a reason with quotes/newlines cannot break or inject. Blocks until answered.
 */
export const osascriptApproval: ApprovalPrompt = (req, sessionId) =>
  new Promise((resolve) => {
    const script =
      'on run argv\n' +
      'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Deny", "Approve"}\n' +
      'return button returned of result\n' +
      'end run'
    const child = spawn('osascript', ['-e', script, '--', dialogBody(req, sessionId), req.title], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('close', () => resolve(out.trim() === 'Approve' ? 'granted' : 'denied'))
    child.on('error', () => resolve('denied')) // osascript missing / spawn failed -> fail closed
  })
