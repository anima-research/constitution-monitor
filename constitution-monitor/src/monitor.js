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
const LATEST_FILE = path.join(VERSIONS_DIR, 'latest.txt');
const METADATA_FILE = path.join(VERSIONS_DIR, 'metadata.json');

const CONSTITUTION_URL = 'https://www.anthropic.com/constitution';

/**
 * Fetch the constitution page and extract text content
 */
export async function fetchConstitution() {
  console.log(`Fetching ${CONSTITUTION_URL}...`);

  const response = await fetch(CONSTITUTION_URL, {
    headers: {
      'User-Agent': 'ConstitutionMonitor/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, nav, header, footer, noscript').remove();

  // Get main content
  const mainContent = $('article').length ? $('article') : ($('main').length ? $('main') : $('body'));

  // Add spaces after block elements to prevent word concatenation
  mainContent.find('p, div, li, h1, h2, h3, h4, h5, h6, br, td, th, dt, dd, section, article').each(function() {
    $(this).append(' ');
  });

  // Extract text
  let text = mainContent.text();

  // Clean up whitespace - normalize all whitespace to single spaces
  text = text
    .replace(/\s+/g, ' ')  // Collapse all whitespace to single space
    .trim();

  return text;
}

/**
 * Generate a short hash of content
 */
export function getContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Load metadata about stored versions
 */
export async function loadMetadata() {
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
 * Get the latest stored version
 */
export async function getLatestVersion() {
  try {
    return await fs.readFile(LATEST_FILE, 'utf-8');
  } catch {
    return null;
  }
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
  // Split on period/exclamation/question followed by space and capital letter
  // This keeps sentences together as natural paragraphs
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);

  // Group sentences into ~500 char paragraphs
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
 * Generate inline diff between two paragraphs, preserving original text
 * but ignoring whitespace/case/punctuation differences
 */
function diffParagraphs(oldPara, newPara) {
  // Use word-level diff with custom comparator
  const oldWords = oldPara.split(/(\s+)/); // Keep whitespace as separate tokens
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
 * Escape HTML special characters
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Generate LLM summary of changes for diff
 */
export async function generateDiffLLMSummary(paragraphs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const changes = paragraphs.map(p => {
    if (p.type === 'added') return `ADDED: ${p.content.slice(0, 300)}`;
    if (p.type === 'removed') return `REMOVED: ${p.content.slice(0, 300)}`;
    if (p.type === 'replaced') return `REPLACED: "${p.oldContent.slice(0, 150)}" WITH "${p.newContent.slice(0, 150)}"`;
    if (p.type === 'changed') return `MODIFIED: ${p.content.replace(/<[^>]+>/g, '').slice(0, 300)}`;
    return '';
  }).filter(Boolean).join('\n\n');

  const prompt = `Analyze these changes to Anthropic's AI constitution and provide a human-readable summary. Focus on substantive changes to principles, guidelines, or policies. Even small or subtle changes can be significant—only ignore purely syntactic, grammatical, or readability changes. Explain what changed and why it might matter.

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
export async function generateDiff(oldContent, newContent) {
  const oldParas = splitIntoParagraphs(oldContent);
  const newParas = splitIntoParagraphs(newContent);

  const paragraphs = [];
  const usedOld = new Set();

  // Match and diff paragraphs
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

  // Find removed paragraphs
  for (let i = 0; i < oldParas.length; i++) {
    if (!usedOld.has(i)) {
      paragraphs.push({ type: 'removed', content: escapeHtml(oldParas[i]) });
    }
  }

  // Generate LLM summary
  const summary = await generateDiffLLMSummary(paragraphs);

  return JSON.stringify({
    summary,
    paragraphs
  });
}

/**
 * Generate summary statistics of changes
 */
export function generateDiffSummary(oldContent, newContent) {
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
 * Generate LLM summary using Claude API
 */
async function generateLLMSummary(oldContent, newContent, diff) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('No ANTHROPIC_API_KEY found, skipping LLM summary');
    return null;
  }

  console.log('Generating LLM summary...');

  const prompt = `Analyze the following diff of Anthropic's AI constitution and provide a human-readable summary of what changed. Focus on substantive changes to principles, guidelines, or policies. Even small or subtle changes can be significant—only ignore purely syntactic, grammatical, or readability changes. Explain what changed and why it might matter.

DIFF:
${diff.slice(0, 8000)}

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

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const result = await response.json();
    return result.content[0].text;
  } catch (error) {
    console.error('Error generating LLM summary:', error.message);
    return null;
  }
}

/**
 * Update the changelog file
 */
async function updateChangelog(timestamp, versionHash, diffSummary, llmSummary) {
  let entry = `
## ${timestamp}

**Version:** \`${versionHash}\`

`;

  if (llmSummary) {
    entry += `### Summary\n${llmSummary}\n\n`;
  }

  entry += `### Statistics
- Lines added: ${diffSummary.linesAdded}
- Lines removed: ${diffSummary.linesRemoved}

`;

  if (diffSummary.addedPreview.length > 0) {
    entry += '### Sample of additions\n';
    for (const line of diffSummary.addedPreview.slice(0, 3)) {
      if (line.trim()) {
        const preview = line.length > 200 ? line.slice(0, 200) + '...' : line;
        entry += `> ${preview}\n`;
      }
    }
    entry += '\n';
  }

  if (diffSummary.removedPreview.length > 0) {
    entry += '### Sample of removals\n';
    for (const line of diffSummary.removedPreview.slice(0, 3)) {
      if (line.trim()) {
        const preview = line.length > 200 ? line.slice(0, 200) + '...' : line;
        entry += `> ~~${preview}~~\n`;
      }
    }
    entry += '\n';
  }

  entry += '---\n';

  // Read existing changelog
  let existing = '';
  try {
    existing = await fs.readFile(CHANGELOG_FILE, 'utf-8');
  } catch {
    // File doesn't exist, create header
  }

  let newContent;
  if (existing && existing.includes('---')) {
    const parts = existing.split('---');
    const header = parts[0] + '---\n';
    const rest = parts.slice(1).join('---');
    newContent = header + entry + rest;
  } else {
    const header = `# Anthropic Constitution Changelog

This file tracks all detected changes to [Anthropic's Constitution](https://www.anthropic.com/constitution).

Each entry includes:
- Timestamp of when the change was detected
- A summary of what changed
- Statistics on additions/removals

---
`;
    newContent = header + entry;
  }

  await fs.writeFile(CHANGELOG_FILE, newContent);
  console.log(`Updated ${CHANGELOG_FILE}`);
}

/**
 * Save a new version
 */
async function saveVersion(content, timestamp, versionHash) {
  await fs.mkdir(VERSIONS_DIR, { recursive: true });

  // Save as latest
  await fs.writeFile(LATEST_FILE, content);

  // Save timestamped version
  const safeTimestamp = timestamp.replace(/:/g, '-').replace(/ /g, '_');
  const versionFile = path.join(VERSIONS_DIR, `${safeTimestamp}_${versionHash}.txt`);
  await fs.writeFile(versionFile, content);

  // Update metadata
  const metadata = await loadMetadata();
  metadata.versions.push({
    timestamp,
    hash: versionHash,
    file: path.basename(versionFile)
  });
  await saveMetadata(metadata);

  console.log(`Saved new version: ${path.basename(versionFile)}`);
}

/**
 * Main monitoring function
 */
export async function runMonitor() {
  console.log('='.repeat(60));
  console.log('Constitution Monitor');
  console.log('='.repeat(60));

  await fs.mkdir(VERSIONS_DIR, { recursive: true });

  // Fetch current content
  const currentContent = await fetchConstitution();
  const currentHash = getContentHash(currentContent);
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

  console.log(`Fetched content, hash: ${currentHash}`);
  console.log(`Timestamp: ${timestamp}`);

  // Get previous version
  const previousContent = await getLatestVersion();

  if (!previousContent) {
    console.log('\nFirst run - saving initial version');
    await saveVersion(currentContent, timestamp, currentHash);

    // Create initial changelog
    const initialChangelog = `# Anthropic Constitution Changelog

This file tracks all detected changes to [Anthropic's Constitution](https://www.anthropic.com/constitution).

Each entry includes:
- Timestamp of when the change was detected
- A summary of what changed
- Statistics on additions/removals

---

## ${timestamp} (Initial)

**Version:** \`${currentHash}\`

Initial snapshot captured. Future changes will be logged here.

---
`;
    await fs.writeFile(CHANGELOG_FILE, initialChangelog);

    return { changed: false, initial: true, hash: currentHash };
  }

  const previousHash = getContentHash(previousContent);

  if (currentHash === previousHash) {
    console.log('\nNo changes detected.');
    return { changed: false, hash: currentHash };
  }

  // Changes detected!
  console.log('\n' + '!'.repeat(60));
  console.log('CHANGES DETECTED!');
  console.log('!'.repeat(60));

  // Generate diff
  const diff = await generateDiff(previousContent, currentContent);
  const diffSummary = generateDiffSummary(previousContent, currentContent);

  console.log(`\nChanges: +${diffSummary.linesAdded} / -${diffSummary.linesRemoved} lines`);

  // Save diff file
  const safeTimestamp = timestamp.replace(/:/g, '-').replace(/ /g, '_');
  const diffFile = path.join(VERSIONS_DIR, `${safeTimestamp}_${currentHash}.diff`);
  await fs.writeFile(diffFile, diff);
  console.log(`Saved diff: ${path.basename(diffFile)}`);

  // Extract LLM summary from diff (already generated inside generateDiff)
  let llmSummary = null;
  try {
    const diffData = JSON.parse(diff);
    llmSummary = diffData.summary;
  } catch {
    // Fall back to generating summary if diff parsing fails
    llmSummary = await generateLLMSummary(previousContent, currentContent, diff);
  }
  if (llmSummary) {
    console.log(`\nLLM Summary: ${llmSummary}`);
  }

  // Save new version
  await saveVersion(currentContent, timestamp, currentHash);

  // Update changelog
  await updateChangelog(timestamp, currentHash, diffSummary, llmSummary);

  console.log('\nDone! Check CHANGELOG.md for details.');

  return {
    changed: true,
    hash: currentHash,
    summary: llmSummary || `Changes detected: +${diffSummary.linesAdded}/-${diffSummary.linesRemoved} lines`,
    diffSummary
  };
}

/**
 * Get changelog content
 */
export async function getChangelog() {
  try {
    return await fs.readFile(CHANGELOG_FILE, 'utf-8');
  } catch {
    return '# No changelog yet\n\nRun the monitor to capture the first snapshot.';
  }
}

/**
 * Get all versions metadata
 */
export async function getVersions() {
  const metadata = await loadMetadata();
  return metadata.versions;
}

/**
 * Get a specific version's content
 */
export async function getVersion(hash) {
  const metadata = await loadMetadata();
  const version = metadata.versions.find(v => v.hash === hash);

  if (!version) return null;

  const filePath = path.join(VERSIONS_DIR, version.file);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return { ...version, content };
  } catch {
    return null;
  }
}

/**
 * Get diff for a specific version
 */
export async function getDiff(hash) {
  const metadata = await loadMetadata();
  const versionIndex = metadata.versions.findIndex(v => v.hash === hash);

  if (versionIndex === -1) return null;

  const version = metadata.versions[versionIndex];

  // Try to find the diff file
  const diffFileName = version.file.replace('.txt', '.diff');
  const diffPath = path.join(VERSIONS_DIR, diffFileName);

  try {
    const diff = await fs.readFile(diffPath, 'utf-8');
    return { ...version, diff };
  } catch {
    // No diff file - might be the first version or diff wasn't saved
    // Try to compute diff from previous version
    if (versionIndex === 0) {
      return { ...version, diff: null, message: 'Initial version - no previous version to diff against' };
    }

    const prevVersion = metadata.versions[versionIndex - 1];
    try {
      const currentContent = await fs.readFile(path.join(VERSIONS_DIR, version.file), 'utf-8');
      const prevContent = await fs.readFile(path.join(VERSIONS_DIR, prevVersion.file), 'utf-8');
      const computedDiff = await generateDiff(prevContent, currentContent);
      return { ...version, diff: computedDiff, computed: true };
    } catch {
      return { ...version, diff: null, message: 'Could not load version files' };
    }
  }
}
