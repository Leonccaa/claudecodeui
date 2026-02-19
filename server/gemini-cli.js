import { spawn } from 'child_process';
import crossSpawn from 'cross-spawn';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Use cross-spawn on Windows for better command execution
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

let activeGeminiProcesses = new Map(); // Track active processes by session ID

function extractGeminiTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }

  return '';
}

function removeProcessEntries(targetProcess) {
  for (const [key, process] of activeGeminiProcesses.entries()) {
    if (process === targetProcess) {
      activeGeminiProcesses.delete(key);
    }
  }
}

function resolveGeminiApprovalMode({ permissionMode, skipPermissions, settingsSkipPermissions }) {
  // Keep Gemini CLI behavior aligned with UI permission mode semantics.
  if (permissionMode) {
    switch (permissionMode) {
      case 'bypassPermissions':
        return 'yolo';
      case 'acceptEdits':
        return 'auto_edit';
      case 'plan':
      case 'default':
      default:
        return 'default';
    }
  }

  // Backward compatibility for legacy settings when permissionMode is missing.
  if (skipPermissions || settingsSkipPermissions) {
    return 'yolo';
  }

  return 'default';
}

function isIgnorableGeminiStderr(line) {
  if (!line) {
    return true;
  }

  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  // Gemini CLI sometimes logs informational notices to stderr.
  return (
    normalized.includes('loaded cached credentials') ||
    normalized.includes('yolo mode is enabled') ||
    normalized.includes('approval mode is enabled')
  );
}

async function spawnGemini(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, skipPermissions, model, images, permissionMode } = options;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    let messageBuffer = ''; // Buffer for accumulating assistant messages
    
    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedShellCommands: [],
      skipPermissions: false
    };
    
    // Build Gemini CLI command
    const args = [];
    
    // Build flags allowing both resume and prompt together (reply in existing session)
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    if (command && command.trim()) {
      // Provide a prompt (works for both new and resumed sessions)
      args.push('-p', command);

      // Add model flag if specified
      if (!sessionId && model) {
        args.push('--model', model);
      }

      // Request streaming JSON
      args.push('--output-format', 'stream-json');
    }
    
    const geminiApprovalMode = resolveGeminiApprovalMode({
      permissionMode,
      skipPermissions,
      settingsSkipPermissions: settings?.skipPermissions
    });
    args.push(`--approval-mode=${geminiApprovalMode}`);
    console.log(
      `🛡️  Using approval mode: ${geminiApprovalMode}` +
      ` (permissionMode=${permissionMode || 'unset'}, skipPermissions=${Boolean(skipPermissions || settings?.skipPermissions)})`
    );
    
    // Use cwd (actual project directory) instead of projectPath
    const workingDir = path.resolve(cwd || projectPath || process.cwd());
    
    console.log('Spawning Gemini CLI:', 'gemini', args.join(' '));
    
    const geminiProcess = spawnFunction('gemini', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { 
        ...process.env,
        // Force unbuffered output for faster streaming
        PYTHONUNBUFFERED: '1',
        NODE_NO_WARNINGS: '1',
        FORCE_COLOR: '1'
      }
    });
    
    // Store process reference for potential abort
    // Use both temporary and captured ID to ensure we can abort even during init
    const tempKey = capturedSessionId || `temp-${Date.now()}`;
    activeGeminiProcesses.set(tempKey, geminiProcess);
    
    let stdoutBuffer = ''; 

    // Handle stdout (streaming JSON responses)
    geminiProcess.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop(); // Re-buffer the incomplete line
      
      for (const line of lines) {
        if (!line.trim()) continue;

        // Skip non-JSON noise
        if (line.includes('YOLO mode is enabled') || line.includes('Loaded cached credentials')) {
          continue;
        }

        try {
          const response = JSON.parse(line);
          
          switch (response.type) {
            case 'init':
              if (response.session_id && !capturedSessionId) {
                capturedSessionId = response.session_id;
                console.log('📝 Captured session ID:', capturedSessionId);
                
                // Update process key with real session ID
                activeGeminiProcesses.set(capturedSessionId, geminiProcess);
                // Also keep temp key for a while just in case
                
                if (ws.setSessionId && typeof ws.setSessionId === 'function') {
                  ws.setSessionId(capturedSessionId);
                }

                if (!sessionId && !sessionCreatedSent) {
                  sessionCreatedSent = true;
                  ws.send({
                    type: 'session-created',
                    sessionId: capturedSessionId,
                    provider: 'gemini',
                    model: response.model,
                    cwd: workingDir
                  });
                }
              }
              
              ws.send({
                type: 'gemini-system',
                data: response,
                sessionId: capturedSessionId || sessionId || null
              });
              break;
              
            case 'message':
              if (response.role === 'user') {
                ws.send({
                  type: 'gemini-user',
                  data: response,
                  sessionId: capturedSessionId || sessionId || null
                });
              } else if (response.role === 'assistant') {
                const textContent = extractGeminiTextContent(response.content);
                if (!textContent) {
                  break;
                }
                messageBuffer += textContent;
                
                ws.send({
                  type: 'claude-response',
                  data: {
                    type: 'content_block_delta',
                    delta: {
                      type: 'text_delta',
                      text: textContent
                    }
                  },
                  sessionId: capturedSessionId || sessionId || null
                });
              }
              break;
              
            case 'tool_use':
              console.log('🛠️ Gemini Tool Use:', response.tool_name);
              ws.send({
                type: 'claude-response',
                data: {
                  type: 'content_block_start',
                  index: 1,
                  content_block: {
                    type: 'tool_use',
                    id: response.tool_id,
                    name: response.tool_name,
                    input: response.parameters
                  }
                },
                sessionId: capturedSessionId || sessionId || null
              });
              break;

            case 'tool_result':
              ws.send({
                type: 'claude-response',
                data: {
                  type: 'message_delta',
                  delta: { stop_reason: 'tool_use' }
                },
                sessionId: capturedSessionId || sessionId || null
              });
              ws.send({
                type: 'gemini-tool-result',
                data: response,
                sessionId: capturedSessionId || sessionId || null
              });
              break;

            case 'result':
              if (messageBuffer) {
                ws.send({
                  type: 'claude-response',
                  data: { type: 'content_block_stop' },
                  sessionId: capturedSessionId || sessionId || null
                });
              }
              
              ws.send({
                type: 'gemini-result',
                sessionId: capturedSessionId || sessionId,
                data: response,
                success: response.status === 'success'
              });
              break;
              
            default:
              ws.send({
                type: 'gemini-response',
                data: response,
                sessionId: capturedSessionId || sessionId || null
              });
          }
        } catch (parseError) {
          console.log('📄 Non-JSON Gemini response:', line);
          ws.send({
            type: 'gemini-output',
            data: line,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      }
    });
    
    geminiProcess.stderr.on('data', (data) => {
      const stderrText = data.toString();
      const actionableError = stderrText.split('\n')
        .filter(line => line.trim() && !isIgnorableGeminiStderr(line))
        .join('\n');

      if (actionableError) {
        console.error('Gemini CLI stderr:', actionableError);
        ws.send({
          type: 'gemini-error',
          error: actionableError,
          sessionId: capturedSessionId || sessionId || null
        });
      }
    });
    
    geminiProcess.on('close', async (code) => {
      console.log(`Gemini CLI process exited with code ${code}`);
      const finalSessionId = capturedSessionId || sessionId || tempKey;
      removeProcessEntries(geminiProcess);

      ws.send({
        type: 'claude-complete',
        sessionId: finalSessionId,
        exitCode: code,
        isNewSession: !sessionId && !!command
      });
      
      resolve();
    });
    
    geminiProcess.on('error', (error) => {
      console.error('Gemini CLI process error:', error);
      removeProcessEntries(geminiProcess);
      reject(error);
    });
    
    geminiProcess.stdin.end();
  });
}

function abortGeminiSession(sessionId) {
  // Try to find process by sessionId or any temp key
  let process = activeGeminiProcesses.get(sessionId);
  
  if (!process) {
    // Search for any temp key that might be associated with this session
    for (const [key, p] of activeGeminiProcesses.entries()) {
      if (key.includes(sessionId)) {
        process = p;
        break;
      }
    }
  }

  if (process) {
    console.log(`🛑 Aborting Gemini session: ${sessionId}`);
    process.kill('SIGTERM');
    
    // Give it a small window to exit gracefully, then SIGKILL
    setTimeout(() => {
      try {
        process.kill('SIGKILL');
      } catch (e) {}
    }, 1000);

    removeProcessEntries(process);
    return true;
  }
  
  console.log(`⚠️  Could not find active process to abort for session: ${sessionId}`);
  return false;
}

function abortAnyGeminiSession() {
  for (const [sessionKey, process] of activeGeminiProcesses.entries()) {
    if (!process) {
      continue;
    }
    console.log(`🛑 Aborting active Gemini process via fallback key: ${sessionKey}`);
    process.kill('SIGTERM');
    setTimeout(() => {
      try {
        process.kill('SIGKILL');
      } catch (_) {}
    }, 1000);
    removeProcessEntries(process);
    return true;
  }
  return false;
}

function isGeminiSessionActive(sessionId) {
  return activeGeminiProcesses.has(sessionId);
}

function getActiveGeminiSessions() {
  return Array.from(activeGeminiProcesses.keys());
}

export {
  spawnGemini,
  abortGeminiSession,
  abortAnyGeminiSession,
  isGeminiSessionActive,
  getActiveGeminiSessions
};
