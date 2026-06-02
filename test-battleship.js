const { io } = require('socket.io-client');
const BACKEND = 'http://localhost:3000';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function connect(name) {
  return new Promise((resolve, reject) => {
    const s = io(BACKEND, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function emit(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout: ${event}`)), 10000);
    socket.emit(event, ...args, (res) => {
      clearTimeout(timeout);
      resolve(res);
    });
  });
}

function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 15000);
    socket.once(event, (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });
}

async function runTest() {
  const errors = [];
  let passed = 0; let failed = 0;
  function check(cond, msg) { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); errors.push(msg); } }

  console.log('\n=== BATTLESHIP INTEGRATION TEST ===\n');

  // Connect both players
  const p1 = await connect('Alice');
  const p2 = await connect('Bob');
  console.log('✅ Both players connected');

  // Player 1 creates room
  const createRes = await emit(p1, 'bsCreateRoom', 'Alice');
  check(createRes.success && createRes.code.length === 4, `Room created: ${createRes.code}`);
  const roomCode = createRes.code;

  // SET UP listeners BEFORE joining (race condition: server emits bsStartPlacement before callback)
  const p1PlacementPromise = waitFor(p1, 'bsStartPlacement');
  const p2PlacementPromise = waitFor(p2, 'bsStartPlacement');

  // Player 2 joins
  const joinRes = await emit(p2, 'bsJoinRoom', { code: roomCode, name: 'Bob' });
  check(joinRes.success && joinRes.playerIndex === 1, 'Player 2 joined room');

  // Now wait for placement events
  const p1Placement = await p1PlacementPromise;
  const p2Placement = await p2PlacementPromise;
  check(p1Placement.opponentName === 'Bob', 'P1 sees opponent name Bob');
  check(p2Placement.opponentName === 'Alice', 'P2 sees opponent name Alice');

  // Place all ships for P1 (set up next-ship listener before each emit)
  const p1Ships = [
    [0, 0, 0, true],
    [1, 1, 0, true],
    [2, 2, 0, true],
    [3, 3, 0, true],
    [4, 4, 0, true],
  ];

  for (const [shipId, row, col, horizontal] of p1Ships) {
    const placedPromise = waitFor(p1, 'bsShipPlaced');
    p1.emit('bsPlaceShip', { shipId, row, col, horizontal });
    const shipPlaced = await placedPromise;
    const shipInData = shipPlaced.shipData.find(s => s.id === shipId);
    check(shipInData && shipInData.cells.length > 0 && shipInData.size > 0,
      `P1 placed ship ${shipId} (cells=${shipInData?.cells?.length}, size=${shipInData?.size})`);
  }

  // Place all ships for P2 (different columns to avoid overlap)
  const p2Ships = [
    [0, 0, 5, false],  // Carrier (5) at F1-F5 vertical
    [1, 1, 6, false],  // Battleship (4) at G2-G5 vertical
    [2, 2, 7, false],  // Cruiser (3) at H3-H5 vertical
    [3, 3, 8, false],  // Submarine (3) at I4-I6 vertical
    [4, 9, 0, true],   // Destroyer (2) at A10-B10 horizontal
  ];

  for (const [shipId, row, col, horizontal] of p2Ships) {
    const placedPromise = waitFor(p2, 'bsShipPlaced');
    p2.emit('bsPlaceShip', { shipId, row, col, horizontal });
    const shipPlaced = await placedPromise;
    const shipInData = shipPlaced.shipData.find(s => s.id === shipId);
    check(shipInData && shipInData.cells.length > 0 && shipInData.size > 0,
      `P2 placed ship ${shipId} (cells=${shipInData?.cells?.length}, size=${shipInData?.size})`);
  }

  console.log('  ✅ All 10 ships placed');

  // Set up listeners for bsGameStart BEFORE clicking ready
  const p1GameStartPromise = waitFor(p1, 'bsGameStart');
  const p2GameStartPromise = waitFor(p2, 'bsGameStart');

  // Both click Ready
  p1.emit('bsReady');
  p2.emit('bsReady');

  // Wait for game start
  const p1GameStart = await p1GameStartPromise;
  const p2GameStart = await p2GameStartPromise;

  check(p1GameStart.playerIndex === 0, 'P1 is player 0');
  check(p2GameStart.playerIndex === 1, 'P2 is player 1');
  check(p1GameStart.opponentName === 'Bob', 'P1 opponent is Bob');
  check(p2GameStart.opponentName === 'Alice', 'P2 opponent is Alice');
  check(p1GameStart.yourBoard !== undefined, 'P1 received board');
  check(p1GameStart.yourShips !== undefined, 'P1 received ships');
  check(p1GameStart.yourShips.every(s => s.size > 0), 'P1 ships have size field');
  check(p2GameStart.yourShips.every(s => s.size > 0), 'P2 ships have size field');
  check(p1GameStart.firstTurn === 0 || p1GameStart.firstTurn === 1, 'First turn is set');

  console.log('  ✅ Both players received bsGameStart (transitioned to PLAY phase)');

  // Determine who goes first
  const firstPlayer = p1GameStart.firstTurn === 0 ? p1 : p2;
  const secondPlayer = p1GameStart.firstTurn === 0 ? p2 : p1;
  const firstIdx = p1GameStart.firstTurn === 0 ? 0 : 1;
  const secondIdx = p1GameStart.firstTurn === 0 ? 1 : 0;

  // First player shoots directly (turn is already set from firstTurn)
  console.log('\n  --- Shooting phase ---');

  // Set up ALL listeners BEFORE shooting (avoid race conditions)
  const shotResultPromise = waitFor(firstPlayer, 'bsShotResult');
  const oppShotPromise = waitFor(secondPlayer, 'bsOpponentShot');
  const turnChange2Promise = waitFor(secondPlayer, 'bsTurnChange');

  firstPlayer.emit('bsShoot', 0, 0);

  const shotResult = await shotResultPromise;
  check(shotResult.row === 0 && shotResult.col === 0, 'Shot result has correct coordinates');
  check(shotResult.opponentBoard !== undefined, 'Shot result includes sanitized board');

  const oppShot = await oppShotPromise;
  check(oppShot.row === 0 && oppShot.col === 0, 'Opponent received shot notification');

  const turnChange2 = await turnChange2Promise;
  check(turnChange2.currentTurn === secondIdx, `Turn changed to player ${secondIdx}`);

  // Second player shoots — set up listener BEFORE emitting
  const p2ShotResultPromise = waitFor(secondPlayer, 'bsShotResult');
  secondPlayer.emit('bsShoot', 5, 5);
  const p2ShotResult = await p2ShotResultPromise;
  check(p2ShotResult.row === 5 && p2ShotResult.col === 5, 'P2 shot result has correct coordinates');

  // --- MULTI-TURN TEST: shoot through 4 turns to verify game doesn't freeze ---
  console.log('\n  --- Multi-turn shooting ---');

  // Track whose turn it is
  let currentShooter = firstPlayer;
  let currentShooterIdx = firstIdx;
  let currentDefender = secondPlayer;
  let currentDefenderIdx = secondIdx;

  for (let i = 0; i < 4; i++) {
    // Set up listeners BEFORE shooting
    const shotResPromise = waitFor(currentShooter, 'bsShotResult');
    const oppShotPromise = waitFor(currentDefender, 'bsOpponentShot');
    const turnChPromise = waitFor(currentDefender, 'bsTurnChange');

    // Shoot at a new cell
    const shotCell = [i + 1, 1]; // (1,1), (2,1), etc.
    currentShooter.emit('bsShoot', shotCell[0], shotCell[1]);

    const shotRes = await shotResPromise;
    check(shotRes.row === shotCell[0] && shotRes.col === shotCell[1],
      `Turn ${i+1}: shooter got result for (${shotCell[0]},${shotCell[1]})`);
    check(shotRes.opponentBoard !== undefined,
      `Turn ${i+1}: opponent board state included`);

    // Check opponent got notified
    await oppShotPromise;

    // Wait for turn change
    await turnChPromise;

    // Swap
    [currentShooter, currentDefender] = [currentDefender, currentShooter];
    [currentShooterIdx, currentDefenderIdx] = [currentDefenderIdx, currentShooterIdx];
  }
  console.log('  ✅ 4 turns completed without freezing');

  // Cleanup
  p1.close();
  p2.close();

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  if (errors.length > 0) {
    console.log('Errors:', errors.join(', '));
    process.exit(1);
  }
  console.log('ALL TESTS PASSED ✅');
}

runTest().catch(err => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
