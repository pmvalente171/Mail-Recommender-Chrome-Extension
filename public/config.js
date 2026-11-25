// Backend address, access key and study participant ID, imported by
// ServiceWorker.js. These are the development defaults (a local backend, no
// key, no participant: nothing is stored for the study). `npm run build`
// replaces build/config.js with the values from config.local.json (gitignored;
// copy config.example.json), so each PC gets its own key and none is committed.
export const BACKEND_URL = 'http://localhost:4000'
export const API_KEY = ''
export const PARTICIPANT = ''
