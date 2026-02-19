import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

async function findSessionFile(sessionId) {
  const tmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  const candidates = [];

  try {
      const entries = await fs.readdir(tmpDir, { withFileTypes: true });
      for (const entry of entries) {
          if (entry.isDirectory()) {
              candidates.push(path.join(tmpDir, entry.name, 'chats'));
          }
      }
  } catch (e) {
      console.log('Error scanning tmp:', e);
  }

  console.log(`Searching in ${candidates.length} directories...`);

  for (const dir of candidates) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.includes(sessionId.slice(0, 8))) {
           console.log(`Found candidate: ${path.join(dir, file)}`);
           const content = await fs.readFile(path.join(dir, file), 'utf8');
           const data = JSON.parse(content);
           if (data.sessionId === sessionId) {
               console.log('MATCH!');
               console.log('Messages count:', data.messages?.length);
               console.log('First message content:', JSON.stringify(data.messages?.[0]?.content));
               return;
           }
        }
      }
    } catch (e) {}
  }
  console.log('Not found.');
}

const sessionId = process.argv[2];
if (sessionId) {
    findSessionFile(sessionId);
} else {
    console.log('Please provide a session ID');
}
