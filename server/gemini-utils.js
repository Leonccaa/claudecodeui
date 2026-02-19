import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Path to the global projects registry
const PROJECTS_JSON_PATH = path.join(os.homedir(), '.gemini', 'projects.json');
const GEMINI_SESSION_READ_RETRIES = 8;
const GEMINI_SESSION_READ_RETRY_DELAY_MS = 60;
const geminiSessionFileCache = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJsonWithRetry(filePath, retries = GEMINI_SESSION_READ_RETRIES) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(GEMINI_SESSION_READ_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastError;
}

function toGeminiSession(data, workingDir, file) {
  let name = data.summary || 'Untitled Session';
  if (name === 'Untitled Session' && data.messages) {
    const firstUser = data.messages.find((m) => m.type === 'user');
    if (firstUser && firstUser.content) {
      if (Array.isArray(firstUser.content)) {
        name = firstUser.content.find((p) => p.text)?.text || 'Untitled Session';
      } else {
        name = firstUser.content || 'Untitled Session';
      }
    }
  }

  return {
    id: data.sessionId,
    name,
    createdAt: data.startTime,
    created_at: data.startTime,
    lastUpdated: data.lastUpdated,
    updated_at: data.lastUpdated,
    projectPath: workingDir,
    messageCount: data.messages?.length || 0,
    file,
    __provider: 'gemini',
    __projectName: path.basename(workingDir),
  };
}

/**
 * Resolves the Gemini Project ID (Short ID) for a given project path.
 * Reads from ~/.gemini/projects.json directly.
 */
export async function getGeminiProjectId(projectPath) {
  try {
    const resolvedPath = path.resolve(projectPath);
    
    try {
      const content = await fs.readFile(PROJECTS_JSON_PATH, 'utf8');
      const registry = JSON.parse(content);
      
      // Registry format: { "projects": { "/abs/path": "short-id", ... } }
      if (registry && registry.projects) {
        // Try exact match
        if (registry.projects[resolvedPath]) {
          return registry.projects[resolvedPath];
        }

        // Fallback: realpath match to handle path aliases/symlinks that point to the same directory.
        let targetRealPath = null;
        try {
          targetRealPath = await fs.realpath(resolvedPath);
        } catch (_) {
          targetRealPath = null;
        }

        if (targetRealPath) {
          for (const [registeredPath, projectId] of Object.entries(registry.projects)) {
            try {
              const registeredRealPath = await fs.realpath(registeredPath);
              if (registeredRealPath === targetRealPath) {
                return projectId;
              }
            } catch (_) {
              // Ignore broken or inaccessible registry entries.
            }
          }
        }
      }
    } catch (readError) {
      // If projects.json doesn't exist or is invalid, we can't look up
      // console.warn('Failed to read Gemini projects registry:', readError.message);
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

export async function getGeminiSessions(projectPath) {
  try {
    const workingDir = projectPath || process.cwd();
    const projectId = await getGeminiProjectId(workingDir);
    
    const sessions = [];
    
    // Strategy 1: Read from filesystem using Project ID
    if (projectId) {
      const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectId, 'chats');
      
      try {
        const files = await fs.readdir(chatsDir);
        for (const file of files) {
          if (file.startsWith('session-') && file.endsWith('.json')) {
            const filePath = path.join(chatsDir, file);
            try {
              const data = await readJsonWithRetry(filePath);
              const normalizedSession = toGeminiSession(data, workingDir, file);
              sessions.push(normalizedSession);
              geminiSessionFileCache.set(filePath, normalizedSession);
            } catch (e) {
              const cachedSession = geminiSessionFileCache.get(filePath);
              if (cachedSession) {
                sessions.push({
                  ...cachedSession,
                  projectPath: workingDir,
                  __projectName: path.basename(workingDir),
                });
              }
            }
          }
        }
      } catch (e) {
        // Directory doesn't exist or other FS error
      }
    }

    // Strategy 2: Fallback to CLI (only if FS failed or returned nothing)
    if (sessions.length === 0) {
        try {
            const { stdout } = await execAsync('gemini --list-sessions', {
                cwd: workingDir,
                env: { ...process.env }
            });
            const lines = stdout.split('\n').filter(line => line.trim());
            for (const line of lines) {
                const match = line.match(/^\s*\d+\.\s+(.*?)\s+\(.*?\)\s+\[(.*?)\]/);
                if (match) {
                    sessions.push({
                        id: match[2],
                        name: match[1],
                        projectPath: workingDir,
                        __provider: 'gemini',
                        __projectName: path.basename(workingDir)
                    });
                }
            }
        } catch (cliError) {
            // CLI failed too
        }
    }

    // Deduplicate sessions by ID
    const uniqueSessions = Array.from(new Map(sessions.map(s => [s.id, s])).values());

    return uniqueSessions.sort((a, b) => new Date(b.lastUpdated || 0) - new Date(a.lastUpdated || 0));
    
  } catch (error) {
    console.error('Error listing Gemini sessions:', error);
    return [];
  }
}
