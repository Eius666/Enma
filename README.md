# Enma

Enma is a personal organizer that merges a calendar, quick notes, and simple finance tracking into one dashboard. The app is written in TypeScript on top of Create React App and ships with Firebase initialization out of the box.

## Local Development

```bash
npm install
npm start
```

The development server runs on [http://localhost:3000](http://localhost:3000) with hot reload and TypeScript type checking.

## Testing & Linting

```bash
npm test
```

The default test runner executes the CRA test suite in watch mode. Add targeted component tests under `src/` as the feature set grows.

## GitHub Pages Quick-Publish Checklist

Run through these steps whenever you need to refresh the public build at https://eius666.github.io/Enma/.

1. `npm install --no-progress` to sync dependencies.  
2. `npm run build` to generate the production bundle.  
3. `npm run deploy` to push the latest `build/` output to the `gh-pages` branch.  
4. Wait for the GitHub Pages job to finish (usually under a minute).  
5. Hard refresh the live site and confirm that the footer timestamp in the deployment logs matches the latest publish.

Need more context? The full walkthrough with screenshots lives in [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Project Structure

- `src/App.tsx` – calendar, notes, and finance tabs with localStorage persistence.
- `src/App.css` – layout and theming tokens for the organizer UI.
- `src/src/firebase.ts` – Firebase initialization (tree-shake the SDK as needed).
- `public/` – CRA static assets and `index.html`.

## Useful Scripts

- `npm start` – run the development server.
- `npm run build` – bundle the production build into `build/`.
- `npm run deploy` – publish the current build to GitHub Pages (uses the `homepage` field in `package.json`).
- `npm test` – execute the CRA test runner.

## Production URL

Once deployed, the app is available at https://eius666.github.io/Enma/ with cached assets served directly from GitHub Pages. The deployment checklist above doubles as an audit trail for the latest publish.
