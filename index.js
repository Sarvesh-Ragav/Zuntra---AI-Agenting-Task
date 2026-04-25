import 'dotenv/config';

import { classifyMessage } from './classifyMessage.js';

const messages = [
  'My payment got deducted but service is not activated',
  'App crashes every time I login',
  'How to change my email address?',
];

const results = [];
for (const message of messages) {
  try {
    results.push(await classifyMessage(message));
  } catch {
    results.push({
      message,
      category: 'Error',
      priority: 'Error',
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

console.log(JSON.stringify(results, null, 2));
