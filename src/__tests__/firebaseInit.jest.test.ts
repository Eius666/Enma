import fs from 'fs';
import path from 'path';

// BUG-11: Firebase Auth is created in src/firebaseApp.ts, which src/index.tsx
// requests next to the app chunk so the session restore starts earlier. The
// whole app must still share ONE Firebase app and ONE Auth instance.

const mockCalls = { initializeApp: 0, getAuth: 0, getFirestore: 0 };
jest.mock('../config/env', () => ({ firebaseConfig: { projectId: 'test-project' } }));
jest.mock('firebase/app', () => ({ initializeApp: (cfg: unknown) => { mockCalls.initializeApp += 1; return { cfg }; } }));
jest.mock('firebase/auth', () => ({ getAuth: (app: unknown) => { mockCalls.getAuth += 1; return { app, kind: 'auth' }; } }));
jest.mock('firebase/firestore', () => ({ getFirestore: (app: unknown) => { mockCalls.getFirestore += 1; return { app, kind: 'db' }; } }));

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the app and the early start share one Firebase app and one Auth', async () => {
  const early = await import('../firebaseApp');
  const firebase = await import('../firebase');
  expect(firebase.auth).toBe(early.auth);
  expect(firebase.default).toBe(early.app);
  expect((firebase.db as unknown as { app: unknown }).app).toBe(early.app);
  expect(mockCalls).toEqual({ initializeApp: 1, getAuth: 1, getFirestore: 1 });
});

test('only src/firebaseApp.ts creates the Firebase app or Auth', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { if (name !== '__tests__') walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/\binitializeApp\(|\bgetAuth\(|\binitializeAuth\(/.test(src)) offenders.push(path.relative(path.join(__dirname, '..'), full));
    }
  };
  walk(path.join(__dirname, '..'));
  expect(offenders).toEqual(['firebaseApp.ts']);
});

test('index.tsx starts Auth only on the app path, before importing the app, and keeps the boot-failure screen', () => {
  const index = read('index.tsx');
  const appBranch = index.slice(index.indexOf('} else {'));
  const adminBranch = index.slice(0, index.indexOf('} else {'));
  expect(adminBranch).not.toMatch(/firebaseApp/);
  expect(appBranch.indexOf("import('./firebaseApp')")).toBeGreaterThan(-1);
  expect(appBranch.indexOf("import('./firebaseApp')")).toBeLessThan(appBranch.indexOf("import('./App')"));
  expect(appBranch).toMatch(/import\('\.\/App'\)[\s\S]*\.catch\(showBootFailure\)/);
  // No static import: main.js stays free of Firebase, a config error still reaches the fallback.
  expect(index).not.toMatch(/^import .*firebase/m);
});
