#!/usr/bin/env node

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

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
  if (!normalized) return 'Tool';
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
    } catch {
      return String(result);
    }
  }

  return '';
}

function isGeminiHistoryToolResultError(toolCall) {
  const status = String(toolCall?.status || '').toLowerCase();
  return status === 'error' || Boolean(toolCall?.error);
}

function parseArgs(argv) {
  const args = {
    sessionId: '',
    projectPath: '',
    apiBase: 'http://127.0.0.1:3001',
    token: '',
    authDb: path.join(process.cwd(), 'server', 'database', 'auth.db'),
    jwtSecret: process.env.JWT_SECRET || 'claude-ui-dev-secret-change-in-production',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--session-id') {
      args.sessionId = argv[i + 1] || '';
      i += 1;
    } else if (current === '--project-path') {
      args.projectPath = argv[i + 1] || '';
      i += 1;
    } else if (current === '--api-base') {
      args.apiBase = argv[i + 1] || args.apiBase;
      i += 1;
    } else if (current === '--token') {
      args.token = argv[i + 1] || '';
      i += 1;
    } else if (current === '--auth-db') {
      args.authDb = argv[i + 1] || args.authDb;
      i += 1;
    } else if (current === '--jwt-secret') {
      args.jwtSecret = argv[i + 1] || args.jwtSecret;
      i += 1;
    }
  }

  return args;
}

function createTokenFromLocalDb(authDbPath, jwtSecret) {
  const db = new Database(authDbPath, { readonly: true });
  try {
    const user = db.prepare('SELECT id, username FROM users ORDER BY id ASC LIMIT 1').get();
    if (!user?.id) {
      return null;
    }
    return jwt.sign(
      { userId: user.id, username: user.username || 'user' },
      jwtSecret,
    );
  } finally {
    db.close();
  }
}

async function findSessionFileById(sessionId) {
  const tmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  let projectDirs = [];
  try {
    projectDirs = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const chatsDir = path.join(tmpDir, dirent.name, 'chats');
    let files = [];
    try {
      files = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(chatsDir, file);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(content);
        if (data?.sessionId === sessionId) {
          return filePath;
        }
      } catch {
        // skip bad files
      }
    }
  }

  return null;
}

function buildExpectedMessages(sessionId, sessionData) {
  const messages = [];

  for (const [index, msg] of (sessionData.messages || []).entries()) {
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
        timestamp: msg.timestamp || '',
      });
    }

    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
      for (const [toolIndex, toolCall] of msg.toolCalls.entries()) {
        const toolCallId = toolCall?.id || `${msg.id || sessionId}-${index}-tool-${toolIndex}`;
        const toolTimestamp = toolCall?.timestamp || msg.timestamp || '';

        messages.push({
          id: `${toolCallId}-use`,
          type: 'tool_use',
          toolCallId,
          toolName: normalizeGeminiToolName(toolCall?.displayName || toolCall?.name || 'Tool'),
          toolInput: toolCall?.args || null,
          timestamp: toolTimestamp,
        });

        messages.push({
          id: `${toolCallId}-result`,
          type: 'tool_result',
          toolCallId,
          output: extractGeminiHistoryToolOutput(toolCall),
          is_error: isGeminiHistoryToolResultError(toolCall),
          timestamp: toolTimestamp,
        });
      }
    }
  }

  return messages;
}

function toToolResultMap(messages) {
  const map = new Map();
  for (const msg of messages) {
    if (msg.type !== 'tool_result') continue;
    map.set(String(msg.toolCallId || msg.id), {
      output: String(msg.output || ''),
      isError: Boolean(msg.is_error),
    });
  }
  return map;
}

function toToolUseMap(messages) {
  const map = new Map();
  for (const msg of messages) {
    if (msg.type !== 'tool_use') continue;
    map.set(String(msg.toolCallId || msg.id), {
      toolName: String(msg.toolName || ''),
    });
  }
  return map;
}

function normalizeOutputText(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

async function main() {
  const { sessionId, projectPath, apiBase, token, authDb, jwtSecret } = parseArgs(process.argv);
  if (!sessionId) {
    console.error('Missing --session-id');
    process.exit(2);
  }

  const localFile = await findSessionFileById(sessionId);
  if (!localFile) {
    console.error(`Local Gemini session not found for sessionId=${sessionId}`);
    process.exit(2);
  }

  const localRaw = await fs.readFile(localFile, 'utf8');
  const localData = JSON.parse(localRaw);
  const expectedMessages = buildExpectedMessages(sessionId, localData);

  const url = new URL(`/api/gemini/sessions/${encodeURIComponent(sessionId)}/messages`, apiBase);
  if (projectPath) {
    url.searchParams.set('projectPath', projectPath);
  }

  const authToken = token || createTokenFromLocalDb(authDb, jwtSecret);
  const headers = {};
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    const body = await response.text();
    console.error(`API error ${response.status}: ${body}`);
    process.exit(2);
  }

  const apiPayload = await response.json();
  const apiMessages = Array.isArray(apiPayload?.messages) ? apiPayload.messages : [];

  const failures = [];

  const expectedToolUses = toToolUseMap(expectedMessages);
  const apiToolUses = toToolUseMap(apiMessages);
  for (const [toolId, expected] of expectedToolUses.entries()) {
    const actual = apiToolUses.get(toolId);
    if (!actual) {
      failures.push(`Missing tool_use in API for toolCallId=${toolId}`);
      continue;
    }
    if (actual.toolName !== expected.toolName) {
      failures.push(
        `tool_use name mismatch for ${toolId}: expected="${expected.toolName}" actual="${actual.toolName}"`,
      );
    }
  }

  const expectedToolResults = toToolResultMap(expectedMessages);
  const apiToolResults = toToolResultMap(apiMessages);
  for (const [toolId, expected] of expectedToolResults.entries()) {
    const actual = apiToolResults.get(toolId);
    if (!actual) {
      failures.push(`Missing tool_result in API for toolCallId=${toolId}`);
      continue;
    }

    const expectedOut = normalizeOutputText(expected.output);
    const actualOut = normalizeOutputText(actual.output);
    if (expectedOut && !actualOut) {
      failures.push(`tool_result output lost for ${toolId}: expected non-empty output`);
    } else if (expectedOut && actualOut && expectedOut !== actualOut) {
      failures.push(`tool_result output mismatch for ${toolId}`);
    }

    if (Boolean(actual.isError) !== Boolean(expected.isError)) {
      failures.push(
        `tool_result error flag mismatch for ${toolId}: expected=${expected.isError} actual=${actual.isError}`,
      );
    }
  }

  const expectedPlainCount = expectedMessages.filter(
    (msg) => msg.type === 'user' || msg.type === 'assistant',
  ).length;
  const apiPlainCount = apiMessages.filter(
    (msg) => msg.type === 'user' || msg.type === 'assistant',
  ).length;
  if (apiPlainCount < expectedPlainCount) {
    failures.push(
      `Plain message count regressed: expected>=${expectedPlainCount} actual=${apiPlainCount}`,
    );
  }

  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} issue(s) found`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }

  const summary = {
    sessionId,
    localFile,
    expectedCount: expectedMessages.length,
    apiCount: apiMessages.length,
    toolUseCount: expectedToolUses.size,
    toolResultCount: expectedToolResults.size,
  };
  console.log('PASS');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(2);
});
