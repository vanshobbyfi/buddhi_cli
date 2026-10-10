# @buddhi-ai/cli

Command-line client for [Buddhi AI](https://askbuddhi.com) — authenticate an agent key
and push memories into your governed company brain.

## Install

```bash
npm install -g @buddhi-ai/cli
```

## Usage

```bash
# Log in with the agent key from the dashboard / onboarding (step 2).
buddhi login --key crtx_xxxxxxxxxxxx --url https://your-buddhi-host

# Confirm the stored credentials
buddhi whoami

# Push a file into a scope you're cleared to write
buddhi push ./decision.md --title "Auth convention" --scope engineering
```

The key authenticates as the human it acts for, so every write is scope-filtered
and audited server-side. Credentials are stored in `~/.buddhi/config.json` (mode 600).

Environment overrides: `BUDDHI_API_KEY`, `BUDDHI_URL`.

## Publishing (maintainers)

```bash
npm run build      # tsc → dist/
npm publish --access public
```
