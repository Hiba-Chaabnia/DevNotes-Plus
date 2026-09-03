import * as vscode from 'vscode';
import * as os     from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FeedbackKind = 'bug' | 'feature' | 'question';

// ─── Constants ────────────────────────────────────────────────────────────────

const ISSUES_NEW = 'https://github.com/Hiba-Chaabnia/DevNotes-Plus/issues/new';

const TEMPLATES: Record<FeedbackKind, string> = {
  bug     : 'bug_report.yml',
  feature : 'feature_request.yml',
  question: 'question.yml',
};

/** Templates with a `diagnostics` field; the others get no environment block. */
const PREFILL_DIAGNOSTICS: Record<FeedbackKind, boolean> = {
  bug     : true,
  feature : false,
  question: true,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Environment block for the issue body. Deliberately limited to versions and
 * platform — no workspace paths, repo names, git identity or note content.
 */
function diagnostics(context: vscode.ExtensionContext): string {
  const version = context.extension.packageJSON.version ?? 'unknown';
  return [
    `DevNotes+: ${version}`,
    `VS Code:   ${vscode.version}`,
    `OS:        ${os.platform()} ${os.release()} (${os.arch()})`,
  ].join('\n');
}

function feedbackUrl(context: vscode.ExtensionContext, kind: FeedbackKind): vscode.Uri {
  // encodeURIComponent, not URLSearchParams: the latter writes spaces as `+`,
  // which is ambiguous next to the literal `+` in "DevNotes+".
  const query = [`template=${encodeURIComponent(TEMPLATES[kind])}`];
  if (PREFILL_DIAGNOSTICS[kind]) {
    query.push(`diagnostics=${encodeURIComponent(diagnostics(context))}`);
  }
  return vscode.Uri.parse(`${ISSUES_NEW}?${query.join('&')}`, true);
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/** Opens the matching issue form on GitHub, with the environment prefilled. */
export function openFeedback(context: vscode.ExtensionContext, kind: FeedbackKind): void {
  vscode.env.openExternal(feedbackUrl(context, kind));
}

/**
 * Asks what kind of feedback this is, then opens the matching form. Picking here
 * rather than sending users to GitHub's template chooser is what lets us prefill.
 */
export async function promptForFeedback(context: vscode.ExtensionContext): Promise<void> {
  // `kind` is reserved by QuickPickItem for separators, hence `feedback`.
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(bug) Report a bug',            feedback: 'bug'      as const },
      { label: '$(lightbulb) Request a feature', feedback: 'feature'  as const },
      { label: '$(question) Ask a question',     feedback: 'question' as const },
    ],
    { placeHolder: 'DevNotes: send feedback' }
  );

  if (picked) openFeedback(context, picked.feedback);
}
