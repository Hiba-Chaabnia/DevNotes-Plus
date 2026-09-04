import * as vscode from 'vscode';
import * as https  from 'https';

// ─── Constants ────────────────────────────────────────────────────────────────

const PUBLISHER = 'HibaChaabnia';
const NAME      = 'devnotes-plus';
const EXT_ID    = `${PUBLISHER}.${NAME}`;

const RELEASES_URL = 'https://github.com/Hiba-Chaabnia/DevNotes-Plus/releases';

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

const KEY_LAST_CHECK = 'devnotes.update.lastCheck';
const KEY_SKIPPED    = 'devnotes.update.skippedVersion';

// ─── Version helpers ──────────────────────────────────────────────────────────

/** [major, minor, patch]; prerelease and build suffixes are dropped. */
function parseVersion(v: string): number[] {
  return v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate), b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

// ─── Registry queries ─────────────────────────────────────────────────────────

function request(
  options: https.RequestOptions,
  payload?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode < 400) resolve(data);
        else reject(new Error(`registry returned ${res.statusCode}`));
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function latestFromMarketplace(): Promise<string | undefined> {
  // filterType 7 = ExtensionName (publisher.name), flags 0x1 = IncludeVersions
  const payload = JSON.stringify({
    filters: [{ criteria: [{ filterType: 7, value: EXT_ID }] }],
    flags  : 1,
  });
  const body = await request(
    {
      hostname: 'marketplace.visualstudio.com',
      path    : '/_apis/public/gallery/extensionquery',
      method  : 'POST',
      headers : {
        'Accept'        : 'application/json;api-version=3.0-preview.1',
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent'    : 'DevNotes-VSCode',
      },
    },
    payload,
  );
  return JSON.parse(body)?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
}

async function latestFromOpenVsx(): Promise<string | undefined> {
  const body = await request({
    hostname: 'open-vsx.org',
    path    : `/api/${PUBLISHER}/${NAME}/latest`,
    method  : 'GET',
    headers : { 'Accept': 'application/json', 'User-Agent': 'DevNotes-VSCode' },
  });
  return JSON.parse(body)?.version;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Notifies about a newer published version, for the users who have VS Code's
 * own auto-update turned off. Fire and forget: any failure — offline, registry
 * error, unparseable response — is silent.
 */
export async function checkForUpdate(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.getConfiguration('devnotesPlus').get<boolean>('checkForUpdates', true)) return;

  // VS Code already keeps the extension current in these two modes.
  const autoUpdate = vscode.workspace.getConfiguration('extensions').get<boolean | string>('autoUpdate');
  if (autoUpdate === true || autoUpdate === 'onlyEnabledExtensions') return;

  const last = context.globalState.get<number>(KEY_LAST_CHECK, 0);
  if (Date.now() - last < CHECK_EVERY_MS) return;
  await context.globalState.update(KEY_LAST_CHECK, Date.now());

  const current = context.extension.packageJSON.version as string;
  // Only official VS Code ships the Marketplace; VSCodium, Cursor and the rest pull from Open VSX.
  const fromMarketplace = vscode.env.appName.includes('Visual Studio Code');

  let latest: string | undefined;
  try {
    latest = fromMarketplace ? await latestFromMarketplace() : await latestFromOpenVsx();
  } catch (err) {
    console.error('[DevNotes] update check failed:', err);
    return;
  }

  if (!latest || !isNewer(latest, current)) return;
  if (context.globalState.get<string>(KEY_SKIPPED) === latest) return;

  const action = await vscode.window.showInformationMessage(
    `DevNotes+ ${latest} is available — you have ${current}.`,
    'Update',
    'Release notes',
    'Skip this version',
  );

  if (action === 'Release notes') {
    vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
  } else if (action === 'Skip this version') {
    await context.globalState.update(KEY_SKIPPED, latest);
  } else if (action === 'Update') {
    await installUpdate();
  }
}

async function installUpdate(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', EXT_ID);
  } catch (err) {
    console.error('[DevNotes] in-place update failed:', err);
    // Leaves the user on the extension page, where the Update button lives.
    vscode.commands.executeCommand('extension.open', EXT_ID);
    return;
  }

  const reload = await vscode.window.showInformationMessage(
    'DevNotes+ updated. Reload to finish.',
    'Reload window',
  );
  if (reload === 'Reload window') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
