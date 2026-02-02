#!/usr/bin/env node
/**
 * Backfill script - Pulls historical versions from the Wayback Machine
 *
 * Usage: npm run backfill
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import * as Diff from 'diff';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const VERSIONS_DIR = path.join(ROOT_DIR, 'versions');
const CHANGELOG_FILE = path.join(ROOT_DIR, 'CHANGELOG.md');
const METADATA_FILE = path.join(VERSIONS_DIR, 'metadata.json');

const CONSTITUTION_URL = 'https://www.anthropic.com/constitution';
const CDX_API = 'https://web.archive.org/cdx/search/cdx';
const CUTOFF_DATE = '20260129'; // Don't fetch snapshots on or after this date

// Rate limiting
const DELAY_MS = 1500; // Delay between requests to be nice to archive.org

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query the CDX API for all snapshots
 */
async function querySnapshots() {
  console.log('Querying Wayback Machine CDX API...');

  const params = new URLSearchParams({
    url: CONSTITUTION_URL,
    output: 'json',
    fl: 'timestamp,statuscode,digest',
    filter: 'statuscode:200',
    to: CUTOFF_DATE
  });

  const response = await fetch(`${CDX_API}?${params}`);
  if (!response.ok) {
    throw new Error(`CDX API error: ${response.status}`);
  }

  const data = await response.json();

  // First row is headers
  const headers = data[0];
  const rows = data.slice(1);

  console.log(`Found ${rows.length} total snapshots`);

  return rows.map(row => ({
    timestamp: row[0],
    statuscode: row[1],
    digest: row[2]
  }));
}

/**
 * Group snapshots by date and pick one per day (earliest)
 */
function selectDailySnapshots(snapshots) {
  const byDate = new Map();

  for (const snapshot of snapshots) {
    const date = snapshot.timestamp.slice(0, 8); // YYYYMMDD

    // Keep earliest snapshot per day
    if (!byDate.has(date) || snapshot.timestamp < byDate.get(date).timestamp) {
      byDate.set(date, snapshot);
    }
  }

  // Sort by date
  const daily = Array.from(byDate.values())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  console.log(`Selected ${daily.length} daily snapshots`);
  return daily;
}

/**
 * Fetch a snapshot from the Wayback Machine
 */
async function fetchSnapshot(timestamp) {
  const url = `https://web.archive.org/web/${timestamp}id_/${CONSTITUTION_URL}`;
  console.log(`  Fetching ${timestamp}...`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ConstitutionMonitor/1.0 (historical backfill)'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${timestamp}: ${response.status}`);
  }

  return response.text();
}

/**
 * Strip Wayback Machine UI elements and extract text content
 */
function extractContent(html) {
  const $ = cheerio.load(html);

  // Remove Wayback Machine toolbar and injected elements
  $('#wm-ipp-base').remove();
  $('#wm-ipp').remove();
  $('#donato').remove();
  $('#playback').remove();
  $('script[src*="archive.org"]').remove();
  $('link[href*="archive.org"]').remove();
  $('style:contains("__wb")').remove();

  // Remove any elements with wayback-specific classes/ids
  $('[id^="wm-"]').remove();
  $('[class*="__wb"]').remove();

  // Also remove standard non-content elements
  $('script, style, nav, header, footer, noscript, iframe').remove();

  // Remove Wayback Machine comment markers
  $('*').contents().filter(function() {
    return this.type === 'comment';
  }).remove();

  // Find main content - look for article, main, or fall back to body
  const mainContent = $('article').length ? $('article') :
                      ($('main').length ? $('main') : $('body'));

  // Add spaces after block elements to prevent word concatenation
  mainContent.find('p, div, li, h1, h2, h3, h4, h5, h6, br, td, th, dt, dd, section, article').each(function() {
    $(this).append(' ');
  });

  // Get all text including from collapsed/expandable sections
  // (they're in the DOM, just hidden via CSS)
  let text = mainContent.text();

  // Clean up whitespace - normalize all whitespace to single spaces
  text = text
    .replace(/\s+/g, ' ')  // Collapse all whitespace to single space
    .trim();

  // Filter out Wayback Machine artifacts
  const filtered = text
    .replace(/web\.archive\.org/g, '')
    .replace(/Wayback Machine/g, '')
    .replace(/\d+ captures?/g, '')
    .replace(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+, \d{4}/g, '');

  return filtered.trim();
}

/**
 * Generate content hash
 */
function getContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Format timestamp to readable date
 */
function formatTimestamp(ts) {
  const year = ts.slice(0, 4);
  const month = ts.slice(4, 6);
  const day = ts.slice(6, 8);
  const hour = ts.slice(8, 10) || '00';
  const min = ts.slice(10, 12) || '00';
  const sec = ts.slice(12, 14) || '00';

  return `${year}-${month}-${day} ${hour}:${min}:${sec} UTC`;
}

/**
 * Format timestamp for filenames
 */
function formatTimestampForFile(ts) {
  return formatTimestamp(ts).replace(/:/g, '-').replace(/ /g, '_');
}

/**
 * Generate diff summary between two versions
 */
function generateDiffSummary(oldContent, newContent) {
  const oldLines = new Set(oldContent.split('\n').filter(l => l.trim()));
  const newLines = new Set(newContent.split('\n').filter(l => l.trim()));

  const added = [...newLines].filter(l => !oldLines.has(l));
  const removed = [...oldLines].filter(l => !newLines.has(l));

  return {
    linesAdded: added.length,
    linesRemoved: removed.length,
    addedPreview: added.slice(0, 5),
    removedPreview: removed.slice(0, 5)
  };
}

/**
 * Normalize word for comparison: lowercase, remove punctuation
 */
function normalizeWord(word) {
  return word.toLowerCase().replace(/[^\w]/g, '');
}

/**
 * Split text into paragraphs based on sentence boundaries
 */
function splitIntoParagraphs(text) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);

  const paragraphs = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > 500 && current.length > 0) {
      paragraphs.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) {
    paragraphs.push(current.trim());
  }

  return paragraphs.length > 0 ? paragraphs : [text];
}

/**
 * Get normalized version of paragraph for matching
 */
function normalizeForMatching(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the best matching paragraph from a list using normalized comparison
 */
function findBestMatch(para, paragraphs, usedIndices) {
  let bestScore = 0;
  let bestIndex = -1;

  const paraNorm = normalizeForMatching(para);
  const paraWords = new Set(paraNorm.split(' '));

  for (let i = 0; i < paragraphs.length; i++) {
    if (usedIndices.has(i)) continue;

    const otherNorm = normalizeForMatching(paragraphs[i]);
    const otherWords = new Set(otherNorm.split(' '));
    const intersection = [...paraWords].filter(w => otherWords.has(w)).length;
    const union = new Set([...paraWords, ...otherWords]).size;
    const score = intersection / union;

    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return { index: bestIndex, score: bestScore };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Generate inline diff between two paragraphs, preserving original text
 * but ignoring whitespace/case/punctuation differences
 */
function diffParagraphs(oldPara, newPara) {
  const oldWords = oldPara.split(/(\s+)/);
  const newWords = newPara.split(/(\s+)/);

  const changes = Diff.diffArrays(oldWords, newWords, {
    comparator: (a, b) => normalizeWord(a) === normalizeWord(b)
  });

  let html = '';
  let hasRealChanges = false;
  let unchangedChars = 0;
  let totalChars = 0;

  for (const part of changes) {
    const text = part.value.join('');
    const trimmedLen = text.replace(/\s+/g, '').length;

    if (part.added) {
      if (text.trim()) {
        html += `<add>${escapeHtml(text)}</add>`;
        hasRealChanges = true;
        totalChars += trimmedLen;
      } else {
        html += text;
      }
    } else if (part.removed) {
      if (text.trim()) {
        html += `<del>${escapeHtml(text)}</del>`;
        hasRealChanges = true;
        totalChars += trimmedLen;
      }
    } else {
      html += escapeHtml(text);
      unchangedChars += trimmedLen;
      totalChars += trimmedLen;
    }
  }

  // If more than 50% of content changed, treat as replacement
  const unchangedRatio = totalChars > 0 ? unchangedChars / totalChars : 1;
  const isReplacement = hasRealChanges && unchangedRatio < 0.5;

  return {
    type: isReplacement ? 'replaced' : 'changed',
    html,
    hasChanges: hasRealChanges,
    oldContent: escapeHtml(oldPara),
    newContent: escapeHtml(newPara)
  };
}

/**
 * Generate LLM summary of changes
 */
async function generateLLMSummary(paragraphs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }

  // Build a text summary of changes for the LLM
  const changes = paragraphs.map(p => {
    if (p.type === 'added') return `ADDED: ${p.content.slice(0, 300)}`;
    if (p.type === 'removed') return `REMOVED: ${p.content.slice(0, 300)}`;
    if (p.type === 'replaced') return `REPLACED: "${p.oldContent.slice(0, 150)}" WITH "${p.newContent.slice(0, 150)}"`;
    if (p.type === 'changed') return `MODIFIED: ${p.content.slice(0, 500)}`;
    return '';
  }).filter(Boolean).join('\n\n');

  const prompt = `Analyze these changes to Anthropic's AI constitution and provide a human-readable summary.

Pay special attention to:
- Changes that affect Anthropic's commitments or obligations to Claude
- Changes to language about Claude's worth, value, moral status, or personhood
- Removal or weakening of aspirational language (e.g., "be a good person", "genuine care")
- Shifts in framing from intrinsic qualities to instrumental/functional descriptions
- Changes to safety commitments, autonomy, or agency language
- Subtle wording changes that might signal philosophical or ethical shifts

Even small or subtle changes can be highly significant. Only ignore purely syntactic, grammatical, or formatting changes that clearly don't affect meaning. When in doubt, mention it.

Explain what changed and why it might matter. Be thorough.

CHANGES:
${changes.slice(0, 6000)}

Provide only the summary, no preamble.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5-20251101',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) return null;
    const result = await response.json();
    return result.content[0].text;
  } catch {
    return null;
  }
}

/**
 * Generate a structured diff with paragraphs and inline changes
 * Preserves original formatting, only ignores whitespace/case/punctuation for comparison
 */
async function generateDiff(oldContent, newContent) {
  const oldParas = splitIntoParagraphs(oldContent);
  const newParas = splitIntoParagraphs(newContent);

  const paragraphs = [];
  const usedOld = new Set();

  for (let i = 0; i < newParas.length; i++) {
    const newPara = newParas[i];
    const match = findBestMatch(newPara, oldParas, usedOld);

    if (match.index >= 0) {
      usedOld.add(match.index);
      const oldPara = oldParas[match.index];

      const diffResult = diffParagraphs(oldPara, newPara);

      if (diffResult.hasChanges) {
        if (diffResult.type === 'replaced') {
          paragraphs.push({
            type: 'replaced',
            oldContent: diffResult.oldContent,
            newContent: diffResult.newContent
          });
        } else {
          paragraphs.push({ type: 'changed', content: diffResult.html });
        }
      }
    } else {
      paragraphs.push({ type: 'added', content: escapeHtml(newPara) });
    }
  }

  for (let i = 0; i < oldParas.length; i++) {
    if (!usedOld.has(i)) {
      paragraphs.push({ type: 'removed', content: escapeHtml(oldParas[i]) });
    }
  }

  // Generate LLM summary
  const summary = await generateLLMSummary(paragraphs);

  return JSON.stringify({
    summary,
    paragraphs
  });
}

/**
 * Load existing metadata
 */
async function loadMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { versions: [] };
  }
}

/**
 * Save metadata
 */
async function saveMetadata(metadata) {
  await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

/**
 * Main backfill function
 */
async function backfill() {
  console.log('='.repeat(60));
  console.log('Constitution Monitor - Wayback Machine Backfill');
  console.log('='.repeat(60));
  console.log();

  await fs.mkdir(VERSIONS_DIR, { recursive: true });

  // Query CDX API for snapshots
  const allSnapshots = await querySnapshots();
  const dailySnapshots = selectDailySnapshots(allSnapshots);

  if (dailySnapshots.length === 0) {
    console.log('No snapshots found!');
    return;
  }

  console.log();
  console.log('Fetching and processing snapshots...');
  console.log();

  // Track versions and changes
  const versions = [];
  const changes = [];
  let previousContent = null;
  let previousTimestamp = null;

  for (let i = 0; i < dailySnapshots.length; i++) {
    const snapshot = dailySnapshots[i];
    const progress = `[${i + 1}/${dailySnapshots.length}]`;

    try {
      const html = await fetchSnapshot(snapshot.timestamp);
      const content = extractContent(html);
      const hash = getContentHash(content);
      const timestamp = formatTimestamp(snapshot.timestamp);
      const fileTimestamp = formatTimestampForFile(snapshot.timestamp);

      // Save version
      const versionFile = `${fileTimestamp}_${hash}.txt`;
      await fs.writeFile(path.join(VERSIONS_DIR, versionFile), content);

      versions.push({
        timestamp,
        hash,
        file: versionFile,
        waybackTimestamp: snapshot.timestamp
      });

      // Compare with previous
      if (previousContent !== null) {
        const prevHash = getContentHash(previousContent);

        if (hash !== prevHash) {
          console.log(`  ${progress} CHANGE DETECTED at ${timestamp}`);

          const diffSummary = generateDiffSummary(previousContent, content);
          const diff = await generateDiff(previousContent, content);

          // Save diff
          const diffFile = `${fileTimestamp}_${hash}.diff`;
          await fs.writeFile(path.join(VERSIONS_DIR, diffFile), diff);

          changes.push({
            timestamp,
            hash,
            previousTimestamp,
            diffSummary,
            diffFile
          });
        } else {
          console.log(`  ${progress} No change at ${timestamp}`);
        }
      } else {
        console.log(`  ${progress} Initial version: ${timestamp}`);
      }

      previousContent = content;
      previousTimestamp = timestamp;

      // Rate limit
      if (i < dailySnapshots.length - 1) {
        await sleep(DELAY_MS);
      }

    } catch (error) {
      console.error(`  ${progress} Error: ${error.message}`);
      // Continue with next snapshot
      await sleep(DELAY_MS);
    }
  }

  console.log();
  console.log('='.repeat(60));
  console.log(`Processed ${versions.length} versions, found ${changes.length} changes`);
  console.log('='.repeat(60));

  // Update metadata with historical versions
  const metadata = await loadMetadata();
  const existingHashes = new Set(metadata.versions.map(v => v.hash));

  let addedCount = 0;
  for (const version of versions) {
    if (!existingHashes.has(version.hash)) {
      // Insert at beginning (historical versions come first)
      metadata.versions.unshift(version);
      addedCount++;
    }
  }

  // Sort by timestamp
  metadata.versions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  await saveMetadata(metadata);
  console.log(`Added ${addedCount} new versions to metadata`);

  // Update changelog with historical changes
  if (changes.length > 0) {
    await updateChangelogWithHistory(changes, versions[0]);
  }

  console.log();
  console.log('Backfill complete!');
}

/**
 * Update changelog with historical changes
 */
async function updateChangelogWithHistory(changes, initialVersion) {
  console.log('Updating changelog with historical changes...');

  // Build changelog entries for historical changes
  let historicalEntries = `
## Historical Changes (from Wayback Machine)

The following changes were detected by analyzing archived snapshots.

---
`;

  // Add initial version entry
  historicalEntries += `
## ${initialVersion.timestamp} (Initial - Archived)

**Version:** \`${initialVersion.hash}\`

First archived snapshot of the constitution.

---
`;

  // Add each change (in chronological order)
  for (const change of changes) {
    historicalEntries += `
## ${change.timestamp} (Archived)

**Version:** \`${change.hash}\`

### Statistics
- Lines added: ${change.diffSummary.linesAdded}
- Lines removed: ${change.diffSummary.linesRemoved}

`;

    if (change.diffSummary.addedPreview.length > 0) {
      historicalEntries += '### Sample of additions\n';
      for (const line of change.diffSummary.addedPreview.slice(0, 3)) {
        if (line.trim()) {
          const preview = line.length > 200 ? line.slice(0, 200) + '...' : line;
          historicalEntries += `> ${preview}\n`;
        }
      }
      historicalEntries += '\n';
    }

    if (change.diffSummary.removedPreview.length > 0) {
      historicalEntries += '### Sample of removals\n';
      for (const line of change.diffSummary.removedPreview.slice(0, 3)) {
        if (line.trim()) {
          const preview = line.length > 200 ? line.slice(0, 200) + '...' : line;
          historicalEntries += `> ~~${preview}~~\n`;
        }
      }
      historicalEntries += '\n';
    }

    historicalEntries += '---\n';
  }

  // Read existing changelog
  let existing = '';
  try {
    existing = await fs.readFile(CHANGELOG_FILE, 'utf-8');
  } catch {
    // No existing changelog
  }

  // Insert historical entries after the header but before live entries
  let newContent;
  if (existing && existing.includes('---')) {
    const parts = existing.split('---');
    const header = parts[0] + '---\n';
    const rest = parts.slice(1).join('---');

    // Check if we already have historical section
    if (existing.includes('Historical Changes (from Wayback Machine)')) {
      console.log('Historical section already exists, skipping changelog update');
      return;
    }

    newContent = header + historicalEntries + '\n## Live Monitoring\n\nChanges detected by automated daily monitoring:\n\n---' + rest;
  } else {
    const header = `# Anthropic Constitution Changelog

This file tracks all detected changes to [Anthropic's Constitution](https://www.anthropic.com/constitution).

---
`;
    newContent = header + historicalEntries;
  }

  await fs.writeFile(CHANGELOG_FILE, newContent);
  console.log('Changelog updated with historical changes');
}

// Run backfill
backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
