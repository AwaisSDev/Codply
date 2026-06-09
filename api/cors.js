// cors.js
// Lets the Codeply desktop app (and any browser) call these API routes
// cross-origin. These routes authenticate with a Bearer token (not cookies),
// so a wildcard allow-origin is safe here.
//
// Usage in a route handler:
//   import { applyCors } from './cors.js';
//   export default async function handler(req, res) {
//     if (applyCors(req, res)) return; // handled the OPTIONS preflight
//     ...
//   }

export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true; // preflight handled — stop here
  }
  return false;
}
