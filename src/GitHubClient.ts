import * as https from 'https';

export function parsePRUrl(url: string): { owner: string; repo: string; number: number } | undefined {
  const m = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

export function parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | undefined {
  const cleaned = remoteUrl.replace(/\.git$/, '');
  const sshMatch   = cleaned.match(/github\.com[:/]([^/]+)\/([^/]+)$/);
  if (sshMatch)   return { owner: sshMatch[1],   repo: sshMatch[2] };
  const httpsMatch = cleaned.match(/github\.com\/([^/]+)\/([^/]+)$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return undefined;
}

export function githubFetchPR(
  token : string,
  owner : string,
  repo  : string,
  number: number,
): Promise<{ title: string; state: string; html_url: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path    : `/repos/${owner}/${repo}/pulls/${number}`,
        method  : 'GET',
        headers : {
          'Authorization': `token ${token}`,
          'User-Agent'   : 'DevNotes-VSCode',
          'Accept'       : 'application/vnd.github+json',
        },
      },
      res => {
        let body = '';
        res.on('data', (c: Buffer) => body += c.toString());
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode && res.statusCode >= 400) reject(new Error(data.message ?? String(res.statusCode)));
            else resolve({ title: data.title, state: data.state, html_url: data.html_url });
          } catch { reject(new Error('Invalid JSON from GitHub API')); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

export function githubCreateIssue(
  token: string,
  owner: string,
  repo : string,
  title: string,
  body : string,
): Promise<{ html_url: string; number: number; title: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ title, body });
    const req = https.request(
      {
        hostname: 'api.github.com',
        path    : `/repos/${owner}/${repo}/issues`,
        method  : 'POST',
        headers : {
          'Authorization'        : `Bearer ${token}`,
          'Accept'               : 'application/vnd.github+json',
          'Content-Type'         : 'application/json',
          'Content-Length'       : Buffer.byteLength(payload),
          'User-Agent'           : 'DevNotes-VSCode',
          'X-GitHub-Api-Version' : '2022-11-28',
        },
      },
      res => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 201) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
