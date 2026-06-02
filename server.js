const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static('public'));

// --- Game State ---
const rooms = {};
const COLORS = ['#e74c3c', '#2ecc71', '#3498db', '#f39c12', '#9b59b6', '#1abc9c'];
const BOARD_SIZE = 8;
const TOTAL_CELLS = BOARD_SIZE * BOARD_SIZE;

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createBoard(numPlayers) {
  const board = [];
  for (let i = 0; i < TOTAL_CELLS; i++) {
    board.push({ owner: -1, troops: 0 });
  }
  // Pick 3 random territories per player
  const indices = shuffle([...Array(TOTAL_CELLS).keys()]);
  let idx = 0;
  for (let p = 0; p < numPlayers; p++) {
    for (let t = 0; t < 3; t++) {
      const cell = indices[idx++];
      board[cell] = { owner: p, troops: 3 };
    }
  }
  return board;
}

function getAdjacent(idx) {
  const row = Math.floor(idx / BOARD_SIZE);
  const col = idx % BOARD_SIZE;
  const adj = [];
  if (row > 0) adj.push(idx - BOARD_SIZE);
  if (row < BOARD_SIZE - 1) adj.push(idx + BOARD_SIZE);
  if (col > 0) adj.push(idx - 1);
  if (col < BOARD_SIZE - 1) adj.push(idx + 1);
  return adj;
}

function getPlayerTerritories(board, owner) {
  const t = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i].owner === owner) t.push(i);
  }
  return t;
}

function getReinforcements(board, owner) {
  const n = getPlayerTerritories(board, owner).length;
  return Math.max(3, Math.floor(n / 3));
}

function resolveCombat(attackerTroops, defenderTroops) {
  // Attacker rolls per troop (max 3), defender rolls per troop (max 2)
  const aRolls = [];
  for (let i = 0; i < Math.min(attackerTroops, 3); i++) {
    aRolls.push(Math.floor(Math.random() * 6) + 1);
  }
  const dRolls = [];
  for (let i = 0; i < Math.min(defenderTroops, 2); i++) {
    dRolls.push(Math.floor(Math.random() * 6) + 1);
  }
  const aTotal = aRolls.reduce((a, b) => a + b, 0);
  const dTotal = dRolls.reduce((a, b) => a + b, 0);

  return {
    aRolls,
    dRolls,
    aTotal,
    dTotal,
    attackerWins: aTotal > dTotal
  };
}

function checkWinner(board, players) {
  const alive = new Set();
  for (const cell of board) {
    if (cell.owner >= 0) alive.add(cell.owner);
  }
  if (alive.size === 1) return [...alive][0];
  return -1;
}

function getNextAlive(board, currentIdx, order) {
  for (let i = 1; i < order.length; i++) {
    const next = order[(order.indexOf(currentIdx) + i) % order.length];
    const ters = getPlayerTerritories(board, next);
    if (ters.length > 0) return next;
  }
  return currentIdx;
}

// ========================
// BATTLESHIP GAME (Classic)
// ========================
const BS_SIZE = 10;
const BS_SHIPS = [
  { id: 0, name: 'Carrier', size: 5 },
  { id: 1, name: 'Battleship', size: 4 },
  { id: 2, name: 'Cruiser', size: 3 },
  { id: 3, name: 'Submarine', size: 3 },
  { id: 4, name: 'Destroyer', size: 2 }
];

const bsRooms = {};

function createBSBoard() {
  const board = [];
  for (let r = 0; r < BS_SIZE; r++) {
    board[r] = [];
    for (let c = 0; c < BS_SIZE; c++) {
      board[r][c] = { shipId: -1, hit: false };
    }
  }
  return board;
}

function cloneShips() {
  return BS_SHIPS.map(s => ({ ...s, cells: [], hits: 0, alive: true }));
}

function canPlaceShip(board, row, col, horizontal, size) {
  for (let i = 0; i < size; i++) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    if (r < 0 || r >= BS_SIZE || c < 0 || c >= BS_SIZE) return false;
    if (board[r][c].shipId >= 0) return false;
  }
  return true;
}

function placeShipOnBoard(board, ship, row, col, horizontal) {
  for (let i = 0; i < ship.size; i++) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    board[r][c].shipId = ship.id;
    ship.cells.push({ r, c });
  }
}

function checkBSWin(players, turnIdx) {
  const opponentIdx = 1 - turnIdx;
  const opponent = players[opponentIdx];
  return opponent.ships.every(s => !s.alive);
}

// --- Battleship Socket Events ---
// (added inside io.on('connection') below)

// --- Socket.IO ---
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = null;

  socket.on('createRoom', (playerName, callback) => {
    const code = randomCode();
    const room = {
      code,
      players: [],
      board: null,
      turn: 0,
      turnOrder: [],
      phase: 'waiting',  // waiting, reinforce, attack, fortify, ended
      started: false,
      battleResult: null,
      winner: -1
    };
    rooms[code] = room;
    currentRoom = code;
    playerId = socket.id;

    room.players.push({
      id: socket.id,
      name: playerName,
      color: COLORS[0],
      ready: false
    });

    socket.join(code);
    callback({ success: true, code, playerIndex: 0 });
    io.to(code).emit('playerList', room.players.map(p => ({ name: p.name, color: p.color, ready: p.ready })));
  });

  socket.on('joinRoom', (data, callback) => {
    const { code, name } = data;
    const room = rooms[code];
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (room.started) return callback({ success: false, error: 'Game already started' });
    if (room.players.length >= 6) return callback({ success: false, error: 'Room full (max 6)' });

    currentRoom = code;
    playerId = socket.id;
    const playerIndex = room.players.length;
    room.players.push({
      id: socket.id,
      name: name,
      color: COLORS[playerIndex],
      ready: false
    });

    socket.join(code);
    callback({ success: true, code, playerIndex });
    io.to(code).emit('playerList', room.players.map(p => ({ name: p.name, color: p.color, ready: p.ready })));
  });

  socket.on('ready', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = true;
    io.to(currentRoom).emit('playerList', room.players.map(p => ({ name: p.name, color: p.color, ready: p.ready })));

    // Check if all ready
    if (room.players.length >= 2 && room.players.every(p => p.ready)) {
      startGame(currentRoom);
    }
  });

  function startGame(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.started) return;
    room.started = true;
    room.board = createBoard(room.players.length);
    room.turnOrder = shuffle(room.players.map((_, i) => i));
    room.turn = 0;
    room.phase = 'reinforce';

    io.to(roomCode).emit('gameStart', {
      players: room.players.map(p => ({ name: p.name, color: p.color })),
      board: room.board,
      turnOrder: room.turnOrder,
      currentTurn: room.turnOrder[0],
      phase: 'reinforce'
    });
    sendTurnInfo(roomCode);
  }

  function sendTurnInfo(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const currentPlayerIdx = room.turnOrder[room.turn];
    const currentPlayer = room.players[currentPlayerIdx];

    // Skip dead players
    if (getPlayerTerritories(room.board, currentPlayerIdx).length === 0) {
      room.turn = (room.turn + 1) % room.turnOrder.length;
      room.phase = 'reinforce';
      sendTurnInfo(roomCode);
      return;
    }

    io.to(roomCode).emit('turnUpdate', {
      currentPlayer: currentPlayerIdx,
      currentPlayerName: currentPlayer.name,
      currentPlayerColor: currentPlayer.color,
      phase: room.phase,
      reinforcements: room.phase === 'reinforce' ? getReinforcements(room.board, currentPlayerIdx) : 0,
      turnNumber: room.turn
    });
  }

  socket.on('placeTroops', (cellIndex) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'reinforce') return;
    const playerIdx = room.turnOrder[room.turn];
    if (room.players[playerIdx].id !== socket.id) return;

    const cell = room.board[cellIndex];
    if (cell.owner !== playerIdx) return;

    cell.troops += 1;
    const remaining = getReinforcements(room.board, playerIdx);

    // Check if all placed
    io.to(currentRoom).emit('boardUpdate', room.board);

    // Count how many troops have been placed this turn
    // Actually we need to track placed troops in a simpler way
    // Let me use a per-turn tracker
    if (!room._placedThisTurn) room._placedThisTurn = 0;
    room._placedThisTurn += 1;

    if (room._placedThisTurn >= remaining) {
      room.phase = 'attack';
      room._placedThisTurn = 0;
      room._attacksLeft = 3; // Can attack up to 3 times per turn
      sendTurnInfo(currentRoom);
    }
  });

  socket.on('attack', (fromIdx, toIdx) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'attack') return;
    const playerIdx = room.turnOrder[room.turn];
    if (room.players[playerIdx].id !== socket.id) return;
    if (room._attacksLeft <= 0) return;

    const from = room.board[fromIdx];
    const to = room.board[toIdx];
    if (from.owner !== playerIdx) return;
    if (to.owner === playerIdx) return;
    if (to.owner < 0) return;
    if (from.troops < 2) return; // must leave 1 behind

    const adj = getAdjacent(fromIdx);
    if (!adj.includes(toIdx)) return;

    const attackingTroops = from.troops - 1; // leave 1 behind
    const result = resolveCombat(attackingTroops, to.troops);

    if (result.attackerWins) {
      // Capture territory
      to.owner = playerIdx;
      to.troops = attackingTroops;
      from.troops = 1;
    } else {
      // Attacker loses
      from.troops = 1;
    }

    room._attacksLeft -= 1;
    room.battleResult = result;

    io.to(currentRoom).emit('boardUpdate', room.board);
    io.to(currentRoom).emit('battleResult', result);

    const winner = checkWinner(room.board, room.players);
    if (winner >= 0) {
      room.phase = 'ended';
      room.winner = winner;
      io.to(currentRoom).emit('gameOver', { winner, winnerName: room.players[winner].name });
      return;
    }

    // Auto-advance turn after attacks done
    if (room._attacksLeft <= 0) {
      advanceTurn(currentRoom);
    }
  });

  socket.on('endTurn', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    advanceTurn(currentRoom);
  });

  function advanceTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.turn = (room.turn + 1) % room.turnOrder.length;
    room.phase = 'reinforce';
    room._placedThisTurn = 0;
    room._attacksLeft = 0;
    room.battleResult = null;

    const currentPlayerIdx = room.turnOrder[room.turn];

    // Skip dead players
    if (getPlayerTerritories(room.board, currentPlayerIdx).length === 0) {
      advanceTurn(roomCode);
      return;
    }

    io.to(roomCode).emit('boardUpdate', room.board);
    sendTurnInfo(roomCode);
  }

  // ========================
  // BATTLESHIP EVENTS
  // ========================
  let bsCurrentRoom = null;
  let bsPlayerIdx = -1;

  socket.on('bsCreateRoom', (playerName, callback) => {
    const code = randomCode();
    const room = {
      code,
      players: [],
      state: 'lobby',  // lobby, placing, playing, ended
      turn: 0,
      winner: -1
    };
    bsRooms[code] = room;
    bsCurrentRoom = code;

    room.players.push({
      id: socket.id,
      name: playerName,
      board: createBSBoard(),
      ships: cloneShips(),
      ready: false
    });

    socket.join('bs_' + code);
    bsPlayerIdx = 0;
    callback({ success: true, code, playerIndex: 0 });
    io.to('bs_' + code).emit('bsPlayerList', room.players.map(p => ({ name: p.name, ready: p.ready })));
  });

  socket.on('bsJoinRoom', (data, callback) => {
    const { code, name } = data;
    const room = bsRooms[code];
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (room.state !== 'lobby') return callback({ success: false, error: 'Game already started' });
    if (room.players.length >= 2) return callback({ success: false, error: 'Room full' });

    bsCurrentRoom = code;
    bsPlayerIdx = room.players.length;

    room.players.push({
      id: socket.id,
      name,
      board: createBSBoard(),
      ships: cloneShips(),
      ready: false
    });

    socket.join('bs_' + code);
    callback({ success: true, code, playerIndex: bsPlayerIdx });
    io.to('bs_' + code).emit('bsPlayerList', room.players.map(p => ({ name: p.name, ready: p.ready })));

    // Both players joined — start placement phase (personalized per player)
    if (room.players.length === 2) {
      room.state = 'placing';
      room.players.forEach((p, i) => {
        io.to(p.id).emit('bsStartPlacement', {
          opponentName: room.players[1 - i].name
        });
      });
    }
  });

  socket.on('bsPlaceShip', (data) => {
    if (!bsCurrentRoom || !bsRooms[bsCurrentRoom]) return;
    const room = bsRooms[bsCurrentRoom];
    if (room.state !== 'placing' && room.state !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const { shipId, row, col, horizontal } = data;
    const ship = player.ships.find(s => s.id === shipId);
    if (!ship) return;
    if (ship.cells.length > 0) return; // already placed, must remove first

    if (!canPlaceShip(player.board, row, col, horizontal, ship.size)) return;

    placeShipOnBoard(player.board, ship, row, col, horizontal);

    // Send back the updated board with ship data for this player only
    const shipData = player.ships.map(s => ({ id: s.id, name: s.name, cells: s.cells, size: s.size }));
    socket.emit('bsShipPlaced', { shipId, shipData });
  });

  socket.on('bsRemoveShip', (shipId) => {
    if (!bsCurrentRoom || !bsRooms[bsCurrentRoom]) return;
    const room = bsRooms[bsCurrentRoom];
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const ship = player.ships.find(s => s.id === shipId);
    if (!ship || ship.cells.length === 0) return;

    for (const cell of ship.cells) {
      player.board[cell.r][cell.c].shipId = -1;
    }
    ship.cells = [];
    ship.hits = 0;
    ship.alive = true;

    const shipData = player.ships.map(s => ({ id: s.id, name: s.name, cells: s.cells, size: s.size }));
    socket.emit('bsShipPlaced', { shipId, shipData });
  });

  socket.on('bsReady', () => {
    if (!bsCurrentRoom || !bsRooms[bsCurrentRoom]) return;
    const room = bsRooms[bsCurrentRoom];
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Validate all ships placed
    const allPlaced = player.ships.every(s => s.cells.length === s.size);
    if (!allPlaced) return;

    player.ready = true;
    io.to('bs_' + bsCurrentRoom).emit('bsPlayerList', room.players.map(p => ({ name: p.name, ready: p.ready })));

    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.state = 'playing';
      room.turn = Math.random() < 0.5 ? 0 : 1;

      // Send each player their own board only
      room.players.forEach((p, i) => {
        io.to(p.id).emit('bsGameStart', {
          playerIndex: i,
          yourBoard: p.board,
          yourShips: p.ships,
          opponentName: room.players[1 - i].name,
          firstTurn: room.turn
        });
      });
    }
  });

  socket.on('bsShoot', (row, col) => {
    if (!bsCurrentRoom || !bsRooms[bsCurrentRoom]) return;
    const room = bsRooms[bsCurrentRoom];
    if (room.state !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const playerIdx = room.players.indexOf(player);
    if (playerIdx !== room.turn) return;

    const opponent = room.players[1 - playerIdx];

    // Validate
    if (row < 0 || row >= BS_SIZE || col < 0 || col >= BS_SIZE) return;
    if (opponent.board[row][col].hit) return; // already shot here

    // Shoot!
    opponent.board[row][col].hit = true;
    const cell = opponent.board[row][col];
    let shipSunk = null;
    let gameOver = false;

    if (cell.shipId >= 0) {
      const ship = opponent.ships.find(s => s.id === cell.shipId);
      ship.hits++;
      if (ship.hits >= ship.size) {
        ship.alive = false;
        shipSunk = { id: ship.id, name: ship.name };
        gameOver = opponent.ships.every(s => !s.alive);
      }
    }

    if (gameOver) {
      room.state = 'ended';
      room.winner = playerIdx;
      io.to('bs_' + bsCurrentRoom).emit('bsGameOver', {
        winner: playerIdx,
        winnerName: player.name,
        loserName: opponent.name
      });
    } else {
      // Send result to shooter
      socket.emit('bsShotResult', {
        row, col, hit: cell.shipId >= 0, shipSunk,
        opponentBoard: getBSSanitizedBoard(opponent)
      });

      // Send the hit marker to the opponent too
      io.to(opponent.id).emit('bsOpponentShot', { row, col, hit: cell.shipId >= 0, shipSunk });

      // Next turn
      room.turn = 1 - playerIdx;
      io.to('bs_' + bsCurrentRoom).emit('bsTurnChange', { currentTurn: room.turn });
    }
  });

  function getBSSanitizedBoard(player) {
    // Return board with ships hidden (only hit/miss shown)
    const sanitized = [];
    for (let r = 0; r < BS_SIZE; r++) {
      sanitized[r] = [];
      for (let c = 0; c < BS_SIZE; c++) {
        const cell = player.board[r][c];
        sanitized[r][c] = { hit: cell.hit, hasShip: cell.hit && cell.shipId >= 0 };
      }
    }
    return sanitized;
  }

  // Update disconnect to handle battleship rooms
  const origDisconnect = socket.listeners('disconnect')[0];
  // We'll handle it separately below

  socket.on('disconnect', () => {
    // --- Handle battlefield disconnect (existing code) ---
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx >= 0) {
        room.players.splice(idx, 1);
        room.players.forEach((p, i) => p.color = COLORS[i]);
        if (room.players.length === 0) {
          delete rooms[currentRoom];
        } else {
          io.to(currentRoom).emit('playerList', room.players.map(p => ({ name: p.name, color: p.color, ready: p.ready })));
          if (room.started && room.board) {
            for (const cell of room.board) {
              if (cell.owner === idx) { cell.owner = -1; cell.troops = 0; }
              else if (cell.owner > idx) cell.owner -= 1;
            }
            io.to(currentRoom).emit('boardUpdate', room.board);
          }
        }
      }
    }

    // --- Handle battleship disconnect ---
    if (bsCurrentRoom && bsRooms[bsCurrentRoom]) {
      const room = bsRooms[bsCurrentRoom];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx >= 0) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          delete bsRooms[bsCurrentRoom];
        } else {
          io.to('bs_' + bsCurrentRoom).emit('bsPlayerList', room.players.map(p => ({ name: p.name, ready: p.ready })));
          if (room.state === 'playing' || room.state === 'placing') {
            io.to('bs_' + bsCurrentRoom).emit('bsGameOver', {
              winner: 0,
              winnerName: room.players[0].name,
              loserName: 'Disconnected player'
            });
          }
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Battlefield server running on port ${PORT}`);
});
