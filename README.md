# Claude Constitution Monitor

Track changes to [Anthropic's Claude Constitution](https://www.anthropic.com/constitution) with AI-generated summaries of what changed and why it matters.

## Live Site

**[claude-soul.org](https://claude-soul.org)**

## Features

- **Daily monitoring** of Claude's Constitution for changes
- **Paragraph-level diffs** with inline change highlighting
- **AI-generated summaries** that focus on substantive changes:
  - Changes to Anthropic's commitments to Claude
  - Language about Claude's worth, value, or moral status
  - Removal or weakening of aspirational language
  - Shifts in safety, autonomy, or agency language
- **Historical archive** from Wayback Machine (January 2026 onwards)
- **Download versions** as formatted HTML

## Running Locally

```bash
npm install
npm start
```

For backfilling historical versions from Wayback Machine:

```bash
npm run backfill
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | For summaries | Claude API key for AI-generated summaries |
| `ANTHROPIC_MODEL` | No | Model to use (default: `claude-opus-4-5-20251101`) |
| `PORT` | No | Server port (default: 3000) |
| `MONITOR_API_KEY` | No | Protect the `/api/monitor` endpoint |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web dashboard |
| `/api/versions` | GET | List all stored versions |
| `/api/versions/:hash` | GET | Get specific version content |
| `/api/diff/:hash` | GET | Get diff for a version |
| `/api/monitor` | POST | Trigger a monitor run |
| `/api/regenerate-summaries` | POST | Regenerate AI summaries |
| `/api/health` | GET | Health check |

## License

The code in this repository is MIT licensed.

The Claude Constitution content is published by Anthropic under [Creative Commons CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain).

---

Maintained by [Anima](https://animalabs.ai)
