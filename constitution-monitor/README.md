# Constitution Monitor

A web app that monitors [Anthropic's Constitution](https://www.anthropic.com/constitution) for changes and displays a changelog.

## Features

- **Web dashboard** showing the full changelog history
- **Daily monitoring** via GitHub Actions
- **Change detection** with diff generation
- **Version history** stored in `versions/`
- **Notifications** via GitHub Issues when changes detected
- **LLM summaries** (optional) using Claude API
- **Railway-ready** for easy deployment

## Quick Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

1. Click the button above or go to [Railway](https://railway.app)
2. Create a new project from this GitHub repo
3. Railway will auto-detect Node.js and deploy
4. Add environment variables (optional):
   - `ANTHROPIC_API_KEY` - For AI-generated change summaries
   - `MONITOR_API_KEY` - To protect the trigger endpoint

## Setup

### Local Development

```bash
# Install dependencies
npm install

# Start the server
npm run dev

# Open http://localhost:3000
```

### GitHub Actions Setup

The monitor runs daily via GitHub Actions:

1. Fork/clone this repository
2. Enable GitHub Actions in **Settings > Actions > General**
3. (Optional) Add secrets:
   - `ANTHROPIC_API_KEY` - For AI summaries

The workflow will:
- Run daily at 9 AM UTC
- Check for changes and update `versions/` and `CHANGELOG.md`
- Create a GitHub Issue if changes are detected
- Commit and push updates automatically

## Project Structure

```
constitution-monitor/
├── src/
│   ├── server.js      # Express web server
│   ├── monitor.js     # Core monitoring logic
│   └── cli.js         # CLI for GitHub Actions
├── public/
│   └── index.html     # Web frontend
├── versions/          # Stored versions and diffs
├── CHANGELOG.md       # Human-readable changelog
├── package.json
├── railway.json       # Railway config
└── .github/
    └── workflows/
        └── monitor.yml
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web dashboard |
| `/api/changelog` | GET | Get changelog as markdown |
| `/api/versions` | GET | List all stored versions |
| `/api/versions/:hash` | GET | Get specific version content |
| `/api/monitor` | POST | Trigger a monitor run (requires API key) |
| `/api/health` | GET | Health check |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `ANTHROPIC_API_KEY` | No | Claude API key for AI summaries |
| `MONITOR_API_KEY` | No | API key to protect `/api/monitor` endpoint |

## How It Works

1. **Fetch**: Downloads the constitution page
2. **Parse**: Extracts text content using Cheerio
3. **Compare**: Checks SHA-256 hash against last version
4. **Diff**: If changed, generates unified diff
5. **Store**: Saves new version with timestamp
6. **Changelog**: Updates CHANGELOG.md
7. **Notify**: Creates GitHub Issue (via Actions)

## Notifications

When changes are detected, GitHub Actions creates an issue. To get notified:

1. **Watch the repository** on GitHub
2. **Enable notifications** for Issues in your GitHub settings

You'll receive an email whenever the constitution changes.

## License

MIT
