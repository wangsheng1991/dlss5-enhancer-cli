# dlss5-enhance — batch image enhancement from your own machine

A command-line client for the enhancer on [dlss5nvidia.com](https://www.dlss5nvidia.com/visual-enhancer). Same API the website calls, same account, same model — but you point it at a folder instead of uploading one picture at a time.

```bash
echo "$PASS" | npx github:wangsheng1991/dlss5-enhancer-cli login --email you@example.com --password-stdin
npx github:wangsheng1991/dlss5-enhancer-cli enhance ./photos --factor 2 --compare
```

## What this is not

- **Not NVIDIA DLSS 5.** There is no game runtime here, nothing is injected into a game, and no `nvngx_dlss*` file is read, written or shipped. It re-renders a supplied image at a larger pixel size.
- **Not a free unlimited service.** Every image is one task on the same account and the same credits as the website.
- **Not a pixel-exact upscaler.** The model regenerates detail; it does not recover the "true" pixels. Call it enhancement, not super resolution.

## Desktop window

`desktop/` is the same engine with a window around it: drop a folder, watch each file move from queued
to done, compare before and after, and keep every result next to its source. It reads the same
credentials file and spends the same credits.

```bash
cd desktop && npm install && npm start   # Electron, dev dependency only
cd desktop && npm run make:dmg           # → ../release/DLSS5 Enhance-0.1.0.dmg
```

**Download:** [DLSS5 Enhance 0.1.0](https://github.com/wangsheng1991/dlss5-enhancer-cli/releases/tag/v0.1.0) (unsigned macOS build; right-click → Open the first time) — or build it yourself with `npm run make:dmg`.

See [desktop/README.md](desktop/README.md) for the checks that need no clicking (`npm run smoke`).

## Requirements

Node 18 or newer. No dependencies, no build step, nothing to compile.

## Sign in

The site supports email + password accounts. Create or set a password there first — a Google-only account has no password and cannot be used from a terminal.

```bash
# password on stdin, never as an argument (argv is visible to other processes)
echo "$PASS" | dlss5-enhance login --email you@example.com --password-stdin

# or let the environment carry it
DLSS5_PASSWORD="$PASS" dlss5-enhance login --email you@example.com

dlss5-enhance whoami     # which account, according to the server
dlss5-enhance logout     # forget the local refresh token; the account is untouched
```

The refresh token is written to `~/.config/dlss5-enhance/credentials.json` with mode `0600`. Override the path with `DLSS5_CREDENTIALS`. For CI, set `DLSS5_TOKEN` to a fresh Firebase ID token and nothing is written to disk.

## Enhance

```bash
dlss5-enhance enhance <file|dir ...> [options]

  --factor <2|4>      target scale (default 2; the 1536 px edge caps it)
  --out <dir>         write results here (default: next to each source)
  --format <f>        webp (default) | png | jpeg
  --seed <n>          default 42
  --steps <n>         inference steps (default 4)
  --force             re-run files whose output already exists
  --dry-run           print what would happen; no network, no credits
  --compare           also write a side-by-side before/after HTML beside each result
  --json              machine-readable summary on stdout
  --concurrency <n>   files in flight (default 1)
  --timeout <min>     per-file wait (default 10)
```

Files come out as `<name>-enhanced.<ext>`. A rerun **skips** anything already produced unless you pass `--force`, so an interrupted batch does not pay twice. The idempotency key is derived from the file bytes plus the settings, which means the server itself also refuses to run the same job twice.

`--dry-run` is the cheap way to check a folder:

```
$ dlss5-enhance enhance ./photos --factor 4 --dry-run
ok   4032x3024-phone.jpg → ./photos/4032x3024-phone-enhanced.webp (1536 × 1152)
ok   screenshot.png → ./photos/screenshot-enhanced.webp (1408 × 1536)
```

What the limits mean in practice:

| Limit | Value | Why |
|---|---|---|
| Output long edge | 1536 px | The model's own ceiling; `--factor 4` becomes 2 when the source is already large — the printout says so. |
| Input size | 10 MiB per file | Upload ceiling. |
| Input pixels | 16 MP | Refused before upload, so a 48 MP phone photo fails instantly instead of after a queue. |
| Formats | JPEG, PNG, WebP | Others are refused, not converted silently. |

## Cost and failure behaviour

- One credit-bearing task per image, charged to your account like the website.
- A file that succeeds and then is re-run is skipped, not re-charged.
- If `--timeout` runs out, the local run stops waiting but **the job keeps running on the server** — it is in your site history and still counted. The message says so.
- Exit codes: `0` everything done, `1` at least one file failed, `2` the command itself was wrong (bad flag, not signed in).

## Privacy

Your image is uploaded to the same processing provider the website uses, through a signed upload URL — it is not processed on your machine. Retention is the provider's, not ours, and this tool does not claim otherwise. Credentials never leave `~/.config/dlss5-enhance/` and are never printed.

## Development

```bash
node --test test/*.test.mjs
```

The tests run against a local stand-in for the whole flow (sign in, upload ticket, submit, poll, download); nothing in the suite reaches the internet or spends a credit.

## License

MIT for the code. NVIDIA, GeForce, DLSS and RTX are trademarks of NVIDIA Corporation. This client is independent and is not affiliated with or endorsed by NVIDIA.

## Related

- [dlss5-visual-enhancer](https://github.com/wangsheng1991/dlss5-visual-enhancer) — Reproduce one documented enhancement example locally: input, output, hashes, compare page.
- [dlss5-compatibility-data](https://github.com/wangsheng1991/dlss5-compatibility-data) — Source-attributed, machine-readable DLSS 5 GPU compatibility data.
- [dlss-5-studio](https://github.com/wangsheng1991/dlss-5-studio) — The Windows RTX desktop app behind dlss5nvidia.com — requirements, release notes, issues.
- [DLSS5NVIDIA](https://www.dlss5nvidia.com/) — the site these projects belong to
