/**
 * Live verification against real Seedr accounts.
 *
 * Exercises the V1 provider end to end: password login, quota, listing, playback
 * URL minting, and HTTP range support. Prints a report; mutates nothing.
 *
 * Run: node scripts/verify-live.ts [--concurrency]
 *
 * Secrets are never printed. Emails appear because the admin needs to identify
 * accounts; passwords never do.
 */

import { loadCredentials } from '../src/core/credentials.ts';
import { SeedrV1Provider } from '../src/providers/seedr-v1.ts';

const CREDENTIALS_PATH =
  process.env['SEEDRPOOL_CREDENTIALS_PATH'] ?? '/opt/stacks/.secrets/seedrpool-credentials.txt';

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function main(): Promise<void> {
  const { accounts, problems } = await loadCredentials(CREDENTIALS_PATH);

  for (const problem of problems) {
    console.log(`credentials line ${problem.line}: ${problem.reason}`);
  }

  if (accounts.length === 0) {
    console.error(`no accounts in ${CREDENTIALS_PATH}`);
    process.exitCode = 1;
    return;
  }

  console.log(`accounts: ${accounts.length}\n`);

  let poolMax = 0;
  let poolUsed = 0;
  let firstVideo: { provider: SeedrV1Provider; fileId: string; name: string; size: number } | null =
    null;

  for (const credential of accounts) {
    const provider = new SeedrV1Provider(credential);
    console.log(`── ${credential.id} (${credential.email})`);

    const health = await provider.healthCheck();
    if (!health.healthy) {
      console.log(`   UNHEALTHY: ${health.reason}\n`);
      continue;
    }

    const quota = await provider.getQuota();
    poolMax += quota.max;
    poolUsed += quota.used;
    console.log(`   quota    ${gib(quota.used)} / ${gib(quota.max)} (${gib(quota.free)} free)`);

    const root = await provider.listFolder(null);
    console.log(`   root     ${root.folders.length} folders, ${root.files.length} files`);

    // Walk one level down to find a video, which is enough to prove playback.
    for (const folder of root.folders) {
      const contents = await provider.listFolder(folder.id);
      const videos = contents.files.filter((f) => f.isVideo);
      const subs = contents.files.filter((f) => /\.(srt|vtt|ass)$/i.test(f.name));
      console.log(
        `   folder   "${folder.path}" → ${videos.length} video, ${subs.length} subtitle`,
      );
      const video = videos[0];
      if (video && !firstVideo) {
        firstVideo = { provider, fileId: video.id, name: video.name, size: video.size };
      }
    }

    const transfers = await provider.listTransfers();
    for (const t of transfers) {
      const dead = t.state === 'running' && t.progress === 0 && t.seeders === 0;
      console.log(
        `   task     ${t.id} ${t.name ?? '(no metadata)'} ${t.state} ${t.progress}% ` +
          `seeders=${t.seeders}${dead ? '  ← DEAD MAGNET' : ''}`,
      );
    }
    console.log('');
  }

  console.log(`pool total: ${gib(poolUsed)} / ${gib(poolMax)}\n`);

  if (!firstVideo) {
    console.log('no video files found; skipping playback checks');
    return;
  }

  console.log(`── playback: ${firstVideo.name}`);
  const playback = await firstVideo.provider.getPlaybackUrl(firstVideo.fileId);
  const host = new URL(playback.url).host;
  const expiry = playback.expiresAt ? new Date(playback.expiresAt * 1000).toISOString() : 'unknown';
  console.log(`   host     ${host}`);
  console.log(`   expires  ${expiry}`);

  const head = await fetch(playback.url, { method: 'HEAD' });
  const contentType = head.headers.get('content-type');
  console.log(`   status   ${head.status}`);
  console.log(`   type     ${contentType}`);
  console.log(`   length   ${head.headers.get('content-length')}`);
  console.log(`   ranges   ${head.headers.get('accept-ranges')}`);

  // Stremio needs mid-file range requests to seek.
  const mid = Math.max(0, Math.floor(firstVideo.size / 2));
  const ranged = await fetch(playback.url, { headers: { Range: `bytes=${mid}-${mid + 1023}` } });
  const bytes = (await ranged.arrayBuffer()).byteLength;
  console.log(`   seek     HTTP ${ranged.status}, ${bytes} bytes from offset ${mid}`);

  const seekOk = ranged.status === 206 && bytes === 1024;
  console.log(`   verdict  ${seekOk ? 'seekable' : 'NOT SEEKABLE'}`);

  // application/octet-stream likely requires behaviorHints.notWebReady = true.
  if (contentType !== null && !contentType.startsWith('video/')) {
    console.log(`   note     content-type is "${contentType}", not video/*`);
    console.log('            → stream.behaviorHints.notWebReady likely required');
  }

  if (process.argv.includes('--concurrency')) {
    await checkConcurrency(playback.url);
  }
}

/**
 * Probes whether one account serves several simultaneous reads.
 *
 * Seedr documents 2 download connections on the free tier but does not say
 * whether streaming counts against that budget. If it does, the pool must spread
 * files across accounts for concurrency, not only for capacity.
 */
async function checkConcurrency(url: string): Promise<void> {
  console.log('\n── concurrency: 4 simultaneous range reads on one account');
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) => {
      const offset = 1_000_000 * (i + 1);
      return fetch(url, { headers: { Range: `bytes=${offset}-${offset + 262143}` } }).then(
        async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength }),
      );
    }),
  );

  let ok = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value.status === 206) ok += 1;
      console.log(`   read ${i + 1}   HTTP ${r.value.status}, ${r.value.bytes} bytes`);
    } else {
      console.log(`   read ${i + 1}   FAILED: ${String(r.reason).slice(0, 80)}`);
    }
  });

  console.log(`   elapsed  ${Date.now() - started}ms`);
  console.log(
    ok === 4
      ? '   verdict  4 concurrent reads served; streaming does not appear capped at 2'
      : `   verdict  only ${ok}/4 succeeded; pool must spread files for concurrency`,
  );
}

await main();
