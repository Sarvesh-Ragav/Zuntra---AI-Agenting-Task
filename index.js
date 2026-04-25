import 'dotenv/config';

import { createInterface } from 'node:readline/promises';

import { classifyMessage } from './classifyMessage.js';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('Enter a customer message (type "exit" to quit).\n');

try {
  while (true) {
    const line = await rl.question('> ');
    const message = line.trim();
    if (message === '') {
      continue;
    }
    if (/^exit$/i.test(message)) {
      break;
    }

    try {
      const result = await classifyMessage(message);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
    }
  }
} finally {
  rl.close();
}
