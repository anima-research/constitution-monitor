# Constitution Monitor

A simple tool that monitors [Anthropic's Constitution](https://www.anthropic.com/constitution) for changes and maintains a changelog.

## What it does

- **Daily monitoring**: Fetches the constitution page daily via GitHub Actions
- **Change detection**: Compares current content against the last stored version
- **Version history**: Stores each version with timestamps in `versions/`
- **Changelog**: Maintains a human-readable [CHANGELOG.md](CHANGELOG.md) with all changes
- **Diff files**: Generates unified diffs showing exactly what changed
- **Notifications**: Creates a GitHub Issue when changes are detected
- **LLM summaries** (optional): Uses Claude to generate human-readable change summaries

## Setup

### 1. Fork or clone this repository

```bash
git clone https://github.com/YOUR_USERNAME/constitution-monitor.git
cd constitution-monitor
```

### 2. Enable GitHub Actions

Go to your repository's **Settings → Actions → General** and ensure Actions are enabled.

### 3. (Optional) Add Anthropic API key for LLM summaries

To get AI-generated summaries of changes:

1. Go to **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `ANTHROPIC_API_KEY`
4. Value: Your Anthropic API key

Without this, the monitor still works but won't generate natural language summaries.

### 4. Run initial snapshot

Either:
- Wait for the scheduled run (9 AM UTC daily), or
- Go to **Actions → Monitor Constitution → Run workflow** to trigger manually

The first run captures the initial snapshot. Subsequent runs will detect changes.

## Repository Structure

```
constitution-monitor/
├── monitor.py           # Main monitoring script
├── requirements.txt     # Python dependencies
├── CHANGELOG.md         # Human-readable changelog (auto-updated)
├── versions/            # Stored versions and diffs
│   ├── latest.txt       # Most recent version
│   ├── metadata.json    # Version metadata
│   ├── YYYY-MM-DD_*.txt # Timestamped versions
│   └── YYYY-MM-DD_*.diff # Change diffs
└── .github/
    └── workflows/
        └── monitor.yml  # GitHub Actions workflow
```

## Notifications

When changes are detected, the workflow:

1. **Creates a GitHub Issue** with the change summary
2. **Commits the changes** to the repository

To get email notifications:
- Go to **Settings → Notifications** on GitHub
- Ensure you're watching the repository
- Enable notifications for Issues

### Alternative notification methods

You can modify `.github/workflows/monitor.yml` to add:
- **Slack**: Use `slackapi/slack-github-action`
- **Discord**: Use `sarisia/actions-status-discord`
- **Email**: Use `dawidd6/action-send-mail`
- **Webhook**: Use `joelwmale/webhook-action`

## Running locally

```bash
# Install dependencies
pip install -r requirements.txt

# Run the monitor
python monitor.py

# With LLM summaries
ANTHROPIC_API_KEY=your_key python monitor.py
```

## How it works

1. Fetches the constitution page using `requests`
2. Extracts text content using BeautifulSoup (strips navigation, scripts, etc.)
3. Compares SHA-256 hash with the previous version
4. If changed:
   - Generates a unified diff
   - Saves the new version with timestamp
   - Updates CHANGELOG.md
   - (Optional) Generates LLM summary via Claude API
5. GitHub Actions commits changes and creates notification issue

## License

MIT
