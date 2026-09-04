import * as vscode from 'vscode';
import { githubStarRepo } from './GitHubClient';

// ─── Constants ────────────────────────────────────────────────────────────────

const OWNER = 'Hiba-Chaabnia';
const REPO  = 'DevNotes-Plus';
const REPO_URL = `https://github.com/${OWNER}/${REPO}`;

const MARKETPLACE_REVIEW =
  'https://marketplace.visualstudio.com/items?itemName=HibaChaabnia.devnotes-plus&ssr=false#review-details';
const OPEN_VSX_REVIEW = 'https://open-vsx.org/extension/HibaChaabnia/devnotes-plus/reviews';

/** Notes created before the one-time prompt is offered. */
const PROMPT_AFTER_NOTES = 10;

const KEY_STARRED  = 'devnotes.star.starred';
const KEY_PROMPTED = 'devnotes.star.prompted';
const KEY_COUNT    = 'devnotes.star.notesCreated';

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Stars the repo for the signed-in user, falling back to opening the repo page
 * when sign-in is declined or the API call fails. Only ever called from an
 * explicit user action — never star silently.
 */
export async function starRepository(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(KEY_PROMPTED, true);

  let session: vscode.AuthenticationSession | undefined;
  try {
    session = await vscode.authentication.getSession('github', ['public_repo'], { createIfNone: true });
  } catch { /* user cancelled sign-in */ }

  if (!session) {
    vscode.env.openExternal(vscode.Uri.parse(REPO_URL));
    return;
  }

  try {
    await githubStarRepo(session.accessToken, OWNER, REPO);
  } catch (err) {
    console.error('[DevNotes] star failed:', err);
    vscode.env.openExternal(vscode.Uri.parse(REPO_URL));
    return;
  }

  await context.globalState.update(KEY_STARRED, true);
  vscode.commands.executeCommand('devnotesPlus.refresh');

  const action = await vscode.window.showInformationMessage(
    'Starred DevNotes+ on GitHub. Thank you!',
    'View repo',
  );
  if (action === 'View repo') vscode.env.openExternal(vscode.Uri.parse(REPO_URL));
}

/** True once the repo has been starred from inside the extension. */
export function hasStarred(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(KEY_STARRED, false);
}

/**
 * Opens the review page of the registry this build most likely installed from.
 * Only official VS Code ships the Marketplace; VSCodium, Cursor and the rest
 * pull from Open VSX, and neither registry accepts reviews over an API.
 */
function openReviewPage(): void {
  const isMarketplace = vscode.env.appName.includes('Visual Studio Code');
  vscode.env.openExternal(vscode.Uri.parse(isMarketplace ? MARKETPLACE_REVIEW : OPEN_VSX_REVIEW));
}

/**
 * Counts a freshly created note and, once, offers to star the repo. Fire and
 * forget — never blocks note creation.
 */
export async function countNoteAndMaybePrompt(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(KEY_PROMPTED, false)) return;

  const count = context.globalState.get<number>(KEY_COUNT, 0) + 1;
  await context.globalState.update(KEY_COUNT, count);
  if (count < PROMPT_AFTER_NOTES) return;

  // Set before showing so a dismissed or ignored toast never comes back.
  await context.globalState.update(KEY_PROMPTED, true);

  const action = await vscode.window.showInformationMessage(
    `${PROMPT_AFTER_NOTES} notes in — enjoying DevNotes+? A star or a review helps other developers find it.`,
    'Star on GitHub',
    'Leave a review',
    'No thanks',
  );
  if (action === 'Star on GitHub') await starRepository(context);
  if (action === 'Leave a review') openReviewPage();
}
