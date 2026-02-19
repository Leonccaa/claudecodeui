import { spawn } from 'child_process';
import crossSpawn from 'cross-spawn';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Use cross-spawn on Windows for better command execution
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

let activeGeminiProcesses = new Map(); // Track active processes by session ID

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
    normalized.includes('yolo mode is enabled')
  );
}

async function spawnGemini(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, skipPermissions, model, images } = options;
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
    
    // Add yolo flag if enabled
    if (skipPermissions || settings.skipPermissions) {
      args.push('--yolo');
      console.log('⚠️  Using --yolo flag (skip permissions)');
    }
    
    // Use cwd (actual project directory) instead of projectPath
    const workingDir = path.resolve(cwd || projectPath || process.cwd());
    
    console.log('Spawning Gemini CLI:', 'gemini', args.join(' '));
    console.log('Working directory:', workingDir);
    console.log('Session info - Input sessionId:', sessionId, 'Resume:', resume);
    
    const geminiProcess = spawnFunction('gemini', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env } // Inherit all environment variables
    });
    
    // Store process reference for potential abort
    const processKey = capturedSessionId || Date.now().toString();
    activeGeminiProcesses.set(processKey, geminiProcess);
    
    // Handle stdout (streaming JSON responses)
    geminiProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString();
      console.log('📤 Gemini CLI stdout:', rawOutput);
      
      const lines = rawOutput.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        // Skip non-JSON lines like YOLO mode warning
        if (line.includes('YOLO mode is enabled') || line.includes('Loaded cached credentials')) {
          continue;
        }

        try {
          const response = JSON.parse(line);
          console.log('📄 Parsed Gemini JSON:', response);
          
          switch (response.type) {
            case 'init':
              if (response.session_id && !capturedSessionId) {
                capturedSessionId = response.session_id;
                console.log('📝 Captured session ID:', capturedSessionId);
                
                if (processKey !== capturedSessionId) {
                  activeGeminiProcesses.delete(processKey);
                  activeGeminiProcesses.set(capturedSessionId, geminiProcess);
                }
                
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
                const textContent = response.content;
                messageBuffer += textContent;
                
                // Map to claude-response for UI compatibility
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
              console.log('✅ Gemini Tool Result:', response.tool_id);
              ws.send({
                type: 'claude-response',
                data: {
                  type: 'message_delta',
                  delta: {
                    stop_reason: 'tool_use'
                  }
                },
                sessionId: capturedSessionId || sessionId || null
              });
              // Forward tool result to UI
              ws.send({
                type: 'gemini-tool-result',
                data: response,
                sessionId: capturedSessionId || sessionId || null
              });
              break;

            case 'result':
              console.log('Gemini session result:', response);
              
              if (messageBuffer) {
                ws.send({
                  type: 'claude-response',
                  data: {
                    type: 'content_block_stop'
                  },
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
      const stderrLines = stderrText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const actionableLines = stderrLines.filter((line) => !isIgnorableGeminiStderr(line));
      if (actionableLines.length === 0) {
        return;
      }

      const actionableError = actionableLines.join('\n');
      console.error('Gemini CLI stderr:', actionableError);
      ws.send({
        type: 'gemini-error',
        error: actionableError,
        sessionId: capturedSessionId || sessionId || null
      });
    });
    
    geminiProcess.on('close', async (code) => {
      console.log(`Gemini CLI process exited with code ${code}`);
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeGeminiProcesses.delete(finalSessionId);

      ws.send({
        type: 'claude-complete',
        sessionId: finalSessionId,
        exitCode: code,
        isNewSession: !sessionId && !!command
      });
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Gemini CLI exited with code ${code}`));
      }
    });
    
    geminiProcess.on('error', (error) => {
      console.error('Gemini CLI process error:', error);
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeGeminiProcesses.delete(finalSessionId);

      ws.send({
        type: 'gemini-error',
        error: error.message,
        sessionId: capturedSessionId || sessionId || null
      });

      reject(error);
    });
    
    geminiProcess.stdin.end();
  });
}

function abortGeminiSession(sessionId) {
  const process = activeGeminiProcesses.get(sessionId);
  if (process) {
    console.log(`🛑 Aborting Gemini session: ${sessionId}`);
    process.kill('SIGTERM');
    activeGeminiProcesses.delete(sessionId);
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
  isGeminiSessionActive,
  getActiveGeminiSessions
};
