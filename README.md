# Battlefield Arena 🎮

A multiplayer game hub — currently featuring **Battlefield**, a turn-based territory conquest game.

## Architecture

```
┌──────────────────────┐     ┌──────────────────┐
│  GitHub Pages        │     │  VPS Backend      │
│  (Static Frontend)   │────▶│  (Socket.IO)      │
│  azelinc.github.io/  │     │  battlefield.repo  │
│  battlefield.repo/   │     └──────────────────┘
└──────────────────────┘
```

- **Frontend**: Static HTML/JS/CSS hosted on GitHub Pages
- **Backend**: Node.js + Socket.IO server running on the VPS
- **Config**: Users set the backend URL via localStorage (set once per device)

## Adding a New Game

1. Create a folder under `games/your-game/`
2. Add `index.html` (and any assets)
3. Use the same Socket.IO URL pattern:
   ```js
   const BACKEND = localStorage.getItem('BF_BACKEND') || window.location.origin;
   const socket = io(BACKEND);
   ```
4. Link to it from the main `index.html` hub page

## Local Development

```bash
# Start the backend
cd server
npm install
npm start

# Open http://localhost:3000 in your browser
# No backend? Set localStorage in dev tools:
#   localStorage.setItem('BF_BACKEND', 'http://localhost:3000')
```

## License

MIT
