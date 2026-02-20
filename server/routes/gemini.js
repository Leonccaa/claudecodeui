import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { getGeminiSessions, getGeminiProjectId } from '../gemini-utils.js';
import { extractProjectDirectory } from '../projects.js';

const router = express.Router();

const GEMINI_TOOL_NAME_ALIASES = {
  run_shell_command: 'BashGemini',
  shell_command: 'BashGemini',
  read_file: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  replace_in_file: 'Edit',
  edit_file: 'Edit',
  grep_search: 'Grep',
  search_file_content: 'Grep',
};

function normalizeGeminiToolName(toolName) {
  const normalized = String(toolName || '').trim();
  if (!normalized) {
    return 'Tool';
  }
  return GEMINI_TOOL_NAME_ALIASES[normalized] || normalized;
}

function extractGeminiHistoryToolOutput(toolCall) {
  const result = toolCall?.result;

  if (typeof result === 'string') {
    return result;
  }

  if (Array.isArray(result)) {
    const candidateLines = result
      .map((item) =>
        item?.functionResponse?.response?.output
        || item?.response?.output
        || item?.output
        || item?.resultDisplay
        || '',
      )
      .filter((value) => typeof value === 'string' && value.trim());
    if (candidateLines.length > 0) {
      return candidateLines.join('\n');
    }
  }

  const direct =
    toolCall?.functionResponse?.response?.output
    || toolCall?.response?.output
    || toolCall?.output
    || toolCall?.resultDisplay
    || toolCall?.displayText
    || toolCall?.message;
  if (typeof direct === 'string' && direct.trim()) {
    return direct;
  }

  if (result != null) {
    try {
      return JSON.stringify(result, null, 2);
    } catch (_) {
      return String(result);
    }
  }

  return '';
}

function isGeminiHistoryToolResultError(toolCall) {
  const status = String(toolCall?.status || '').toLowerCase();
  return status === 'error' || Boolean(toolCall?.error);
}

async function resolveProjectRoot(projectPathParam) {
  if (!projectPathParam || typeof projectPathParam !== 'string') {
    return null;
  }

  // Already an absolute path from frontend (preferred).
  if (path.isAbsolute(projectPathParam)) {
    return projectPathParam;
  }

  // CloudCLI project name (e.g. "-Users-max-...") -> actual path via shared resolver.
  try {
    const extracted = await extractProjectDirectory(projectPathParam);
    if (extracted && path.isAbsolute(extracted)) {
      return extracted;
    }
  } catch (_) {}

  return null;
}

async function findSessionInChatsDir(chatsDir, sessionId) {
  let files = [];
  try {
    files = await fs.readdir(chatsDir);
  } catch (_) {
    return null;
  }

  const candidates = files.filter((file) => file.endsWith('.json'));

  // Exact match by parsing sessionId first.
  for (const file of candidates) {
    const filePath = path.join(chatsDir, file);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(content);
      if (data?.sessionId === sessionId) {
        return filePath;
      }
    } catch (_) {}
  }

  // Fallback: filename prefix lookup when JSON parse fails.
  const prefix = sessionId.slice(0, 8);
  const byPrefix = candidates.find((file) => file.includes(prefix));
  if (byPrefix) {
    return path.join(chatsDir, byPrefix);
  }

  return null;
}

async function readSessionData(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

// Helper to find session file
async function findSessionFile(sessionId, projectRoot) {
  const tmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  
  // 1. Try scoped lookup using ProjectRegistry.
  if (projectRoot) {
      try {
          const projectId = await getGeminiProjectId(projectRoot);
          if (projectId) {
              const smartDir = path.join(tmpDir, projectId, 'chats');
              const filePath = await findSessionInChatsDir(smartDir, sessionId);
              if (filePath) {
                  return filePath;
              }
          }
      } catch (e) {
          // Fallback to brute force
      }
  }

  // 2. Brute force fallback
  try {
      const entries = await fs.readdir(tmpDir, { withFileTypes: true });
      for (const entry of entries) {
          if (entry.isDirectory()) {
              const chatsDir = path.join(tmpDir, entry.name, 'chats');
              const filePath = await findSessionInChatsDir(chatsDir, sessionId);
              if (filePath) {
                return filePath;
              }
          }
      }
  } catch (e) {}
  
  return null;
}

// GET /api/gemini/sessions - List Gemini sessions
router.get('/sessions', async (req, res) => {
  try {
    const { projectPath } = req.query;
    const workingDir = await resolveProjectRoot(projectPath) || process.cwd();
    const sessions = await getGeminiSessions(workingDir);
    res.json({ success: true, sessions: sessions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list sessions', details: error.message });
  }
});

// GET /api/gemini/sessions/:sessionId/messages
router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { projectPath } = req.query;
    const resolvedProjectRoot = await resolveProjectRoot(projectPath);
    let filePath = await findSessionFile(sessionId, resolvedProjectRoot);
    
    if (!filePath) {
      return res.status(404).json({ error: 'Session file not found' });
    }

    let data = await readSessionData(filePath);

    // Guard against false-positive filename matches and malformed files.
    if (!data || data.sessionId !== sessionId) {
      const fallbackPath = await findSessionFile(sessionId, null);
      if (fallbackPath && fallbackPath !== filePath) {
        filePath = fallbackPath;
        data = await readSessionData(filePath);
      }
    }

    if (!data || data.sessionId !== sessionId) {
      return res.status(404).json({ error: 'Session data not found or invalid' });
    }
    
    const messages = [];

    for (const [index, msg] of (data.messages || []).entries()) {
      let type = 'user';
      if (msg.type === 'model' || msg.type === 'gemini') {
        type = 'assistant';
      }

      let content = '';
      if (Array.isArray(msg.content)) {
        content = msg.content
          .map((part) => {
            if (typeof part === 'string') return part;
            return part?.text || '';
          })
          .join('');
      } else if (typeof msg.content === 'string') {
        content = msg.content;
      }

      if (content.trim()) {
        messages.push({
          id: msg.id || `${sessionId}-${index}`,
          type,
          content,
          timestamp: msg.timestamp || new Date().toISOString(),
        });
      }

      if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        for (const [toolIndex, toolCall] of msg.toolCalls.entries()) {
          const toolCallId = toolCall?.id || `${msg.id || sessionId}-${index}-tool-${toolIndex}`;
          const toolTimestamp = toolCall?.timestamp || msg.timestamp || new Date().toISOString();

          messages.push({
            id: `${toolCallId}-use`,
            type: 'tool_use',
            toolName: normalizeGeminiToolName(toolCall?.displayName || toolCall?.name || 'Tool'),
            toolInput: toolCall?.args || null,
            toolCallId,
            timestamp: toolTimestamp,
          });

          const toolOutput = extractGeminiHistoryToolOutput(toolCall);
          const toolError = isGeminiHistoryToolResultError(toolCall);

          messages.push({
            id: `${toolCallId}-result`,
            type: 'tool_result',
            toolCallId,
            output: toolOutput,
            is_error: toolError,
            timestamp: toolTimestamp,
          });
        }
      }
    }

    res.json({
      success: true,
      messages: messages,
      total: messages.length,
      hasMore: false 
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to read messages', details: error.message });
  }
});

// DELETE /api/gemini/sessions/:sessionId
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { projectPath } = req.query;
    const resolvedProjectRoot = await resolveProjectRoot(projectPath);
    let filePath = await findSessionFile(sessionId, resolvedProjectRoot);

    // Keep delete behavior consistent with read: allow a global fallback search.
    if (!filePath) {
      filePath = await findSessionFile(sessionId, null);
    }

    if (!filePath) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    await fs.unlink(filePath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Delete failed', details: error.message });
  }
});

// GET /api/gemini/config
router.get('/config', async (req, res) => {
    res.json({ success: true, config: { model: "auto-gemini-3", approvalMode: "default" } });
});

export default router;
