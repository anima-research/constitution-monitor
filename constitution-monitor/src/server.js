import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMonitor, getChangelog, getVersions, getVersion } from './monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes

/**
 * GET /api/changelog
 * Returns the changelog as markdown
 */
app.get('/api/changelog', async (req, res) => {
  try {
    const changelog = await getChangelog();
    res.json({ changelog });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/versions
 * Returns list of all stored versions
 */
app.get('/api/versions', async (req, res) => {
  try {
    const versions = await getVersions();
    res.json({ versions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/versions/:hash
 * Returns a specific version's content
 */
app.get('/api/versions/:hash', async (req, res) => {
  try {
    const version = await getVersion(req.params.hash);
    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }
    res.json(version);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/monitor
 * Trigger a monitor run (protected by API key)
 */
app.post('/api/monitor', async (req, res) => {
  // Simple API key protection for the trigger endpoint
  const apiKey = req.headers['x-api-key'] || req.query.key;
  const expectedKey = process.env.MONITOR_API_KEY;

  if (expectedKey && apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Monitor triggered via API');
    const result = await runMonitor();
    res.json(result);
  } catch (error) {
    console.error('Monitor error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve the frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Constitution Monitor running on http://localhost:${PORT}`);
});
