/**
 * Chess Game Controller
 * Wires chess.js 0.x (game logic) with chessboard.js 1.x (visual board).
 *
 * chess.js 0.x API used:
 *   game_over(), in_check(), in_checkmate(), in_stalemate(),
 *   in_draw(), in_threefold_repetition(), insufficient_material(),
 *   moves(), move(), undo(), board(), get(), fen(), pgn(), history()
 */

// Wikipedia piece set served from chessboardjs.com CDN
const PIECE_THEME = 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png';

// ── State ─────────────────────────────────────────────────────────────────────
let game;                // Chess instance (chess.js 0.x)
let board;               // Chessboard instance (chessboard.js 1.x)
let gameMode    = 'hvh'; // 'hvh' | 'hva' | 'hvo'
let playerColor = 'w';   // human's color in hva mode
let myColor     = 'w';   // this client's color in hvo mode
let roomActive  = false; // true when an online game is in progress
let aiThinking  = false; // block input while AI computes
let lastMove    = null;  // { from, to } for last-move highlight
let hlSquares   = [];    // squares currently showing hover highlights

// ── Bootstrap ─────────────────────────────────────────────────────────────────
$(document).ready(() => {
  bindControls();
  startNewGame();
});

// ── Game Init ─────────────────────────────────────────────────────────────────
function startNewGame() {
  if (gameMode === 'hvo') return; // online mode: room UI handles game start

  game       = new Chess();
  lastMove   = null;
  aiThinking = false;
  hlSquares  = [];
  $('#promotion-modal').addClass('hidden');

  const orientation = (gameMode === 'hva' && playerColor === 'b') ? 'black' : 'white';

  if (board) {
    board.destroy();
  }

  board = Chessboard('board', {
    draggable: true,
    position: 'start',
    orientation,
    pieceTheme: PIECE_THEME,
    onDragStart,
    onDrop,
    onSnapEnd,
    onMouseoverSquare,
    onMouseoutSquare,
  });

  updateStatus();
  renderMoveHistory();
  updateCapturedPieces();

  // If AI plays White, make the opening move
  if (gameMode === 'hva' && playerColor === 'b') {
    triggerAiMove();
  }
}

// ── chessboard.js Callbacks ────────────────────────────────────────────────────
function onDragStart(source, piece) {
  if (game.game_over() || aiThinking) return false;

  const pieceColor = piece[0]; // 'w' or 'b'

  if (gameMode === 'hvh') {
    return pieceColor === game.turn();
  }
  if (gameMode === 'hvo') {
    if (!roomActive) return false;
    return pieceColor === myColor && game.turn() === myColor;
  }
  // hva: only allow the human's pieces on the human's turn
  return pieceColor === playerColor && game.turn() === playerColor;
}

function onMouseoverSquare(square, piece) {
  if (game.game_over() || aiThinking || !piece) return;

  const pieceColor = piece[0];
  if (pieceColor !== game.turn()) return;
  if (gameMode === 'hva' && pieceColor !== playerColor) return;
  if (gameMode === 'hvo' && pieceColor !== myColor) return;

  const moves = game.moves({ square, verbose: true });
  if (!moves.length) return;

  addHighlight(square, 'hl-selected');
  hlSquares.push(square);

  moves.forEach(m => {
    const cls = game.get(m.to) ? 'hl-capture' : 'hl-move';
    addHighlight(m.to, cls);
    hlSquares.push(m.to);
  });
}

function onMouseoutSquare() {
  clearHighlights();
}

function onDrop(source, target) {
  clearHighlights();

  const movingPiece = game.get(source);

  // ── Pawn promotion ───────────────────────────────────────────────────────
  if (
    movingPiece &&
    movingPiece.type === 'p' &&
    ((movingPiece.color === 'w' && target[1] === '8') ||
     (movingPiece.color === 'b' && target[1] === '1'))
  ) {
    // Verify the target square is a legal destination before showing dialog
    const legal = game.moves({ square: source, verbose: true }).some(m => m.to === target);
    if (!legal) return 'snapback';
    showPromotionDialog(movingPiece.color, source, target);
    return 'snapback'; // piece snaps back; board updated after dialog choice
  }

  // ── Normal move ──────────────────────────────────────────────────────────
  const result = game.move({ from: source, to: target });
  if (!result) return 'snapback';

  lastMove = { from: result.from, to: result.to };
  highlightLastMove();
  afterMove();
  if (gameMode === 'hvo') Multiplayer.sendMove(game.fen(), result.from, result.to);
}

function onSnapEnd() {
  // Keep board display in sync after snap animation
  board.position(game.fen());
}

// ── Promotion Dialog ───────────────────────────────────────────────────────────
function showPromotionDialog(color, from, to) {
  const $choices = $('#promotion-choices').empty();
  const labels   = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };

  ['q', 'r', 'b', 'n'].forEach(p => {
    const imgCode = color + p.toUpperCase(); // e.g. "wQ", "bR"
    const url     = `https://chessboardjs.com/img/chesspieces/wikipedia/${imgCode}.png`;

    $('<div class="promo-piece">')
      .css('background-image', `url(${url})`)
      .attr('title', labels[p])
      .on('click', () => {
        $('#promotion-modal').addClass('hidden');
        completePromotion(from, to, p);
      })
      .appendTo($choices);
  });

  $('#promotion-modal').removeClass('hidden');
}

function completePromotion(from, to, promotion) {
  const result = game.move({ from, to, promotion });
  if (!result) return;
  lastMove = { from, to };
  board.position(game.fen());
  highlightLastMove();
  afterMove();
  if (gameMode === 'hvo') Multiplayer.sendMove(game.fen(), from, to);
}

// ── Post-Move Orchestration ────────────────────────────────────────────────────
function afterMove() {
  updateStatus();
  renderMoveHistory();
  updateCapturedPieces();

  if (gameMode === 'hva' && !game.game_over() && game.turn() !== playerColor) {
    triggerAiMove();
  }
}

function triggerAiMove() {
  aiThinking = true;
  updateStatus(); // show "AI is thinking…"

  // setTimeout yields the event loop so the UI can repaint before the
  // synchronous minimax calculation blocks the thread.
  setTimeout(() => {
    const best = ChessAI.getBestMove(game, 3);
    if (best) {
      const result = game.move(best);
      if (result) {
        lastMove = { from: result.from, to: result.to };
        board.position(game.fen());
        highlightLastMove();
      }
    }
    aiThinking = false;
    updateStatus();
    renderMoveHistory();
    updateCapturedPieces();
  }, 50);
}

// ── UI Updates ─────────────────────────────────────────────────────────────────

function updateCapturedPieces() {
  const START  = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const ORDER  = ['q', 'r', 'b', 'n', 'p'];

  // Count pieces still on the board
  const onBoard = { w: {p:0,n:0,b:0,r:0,q:0}, b: {p:0,n:0,b:0,r:0,q:0} };
  game.board().forEach(row => row.forEach(sq => {
    if (sq) onBoard[sq.color][sq.type]++;
  }));

  // How many of each piece type have been captured, keyed by the captured colour
  const captured = { w: {}, b: {} };
  let whiteCapturedValue = 0, blackCapturedValue = 0;
  ORDER.forEach(type => {
    captured.w[type] = START[type] - onBoard.w[type]; // white pieces captured (by Black)
    captured.b[type] = START[type] - onBoard.b[type]; // black pieces captured (by White)
    blackCapturedValue += captured.w[type] * VALUES[type];
    whiteCapturedValue += captured.b[type] * VALUES[type];
  });

  function buildHTML(capturedColor) {
    let html = '';
    ORDER.forEach(type => {
      const count = captured[capturedColor][type];
      for (let i = 0; i < count; i++) {
        const code = capturedColor + type.toUpperCase(); // e.g. 'bP', 'wQ'
        html += `<img class="cap-piece" src="https://chessboardjs.com/img/chesspieces/wikipedia/${code}.png" alt="${type}">`;
      }
    });
    return html;
  }

  const diff = whiteCapturedValue - blackCapturedValue;
  const wAdvHtml = diff > 0 ? `<span class="cap-advantage">+${diff}</span>` : '';
  const bAdvHtml = diff < 0 ? `<span class="cap-advantage">+${-diff}</span>` : '';

  // Top bar = Black: show white pieces Black has captured
  // Bottom bar = White: show black pieces White has captured
  $('#top-captured').html(buildHTML('w') + bAdvHtml);
  $('#bottom-captured').html(buildHTML('b') + wAdvHtml);
}

function updateStatus() {
  const $bar  = $('#status-bar');
  const $text = $('#status-text');
  $bar.attr('class', '');

  if (aiThinking) {
    $text.text('AI is thinking\u2026');
    $bar.addClass('thinking');
    return;
  }

  // chess.js 0.x API
  if (game.in_checkmate()) {
    const winner = game.turn() === 'w' ? 'Black' : 'White';
    $text.text(`Checkmate \u2014 ${winner} wins!`);
    $bar.addClass('checkmate');
  } else if (game.in_stalemate()) {
    $text.text('Stalemate \u2014 Draw!');
    $bar.addClass('draw');
  } else if (game.in_threefold_repetition()) {
    $text.text('Draw by threefold repetition.');
    $bar.addClass('draw');
  } else if (game.insufficient_material()) {
    $text.text('Draw \u2014 insufficient material.');
    $bar.addClass('draw');
  } else if (game.in_draw()) {
    $text.text('Draw by fifty-move rule.');
    $bar.addClass('draw');
  } else if (game.in_check()) {
    const who = game.turn() === 'w' ? 'White' : 'Black';
    $text.text(`${who} is in check!`);
    $bar.addClass('check');
  } else {
    const who = game.turn() === 'w' ? 'White' : 'Black';
    $text.text(`${who} to move`);
    $bar.addClass('active');
  }
}

function renderMoveHistory() {
  const history = game.history(); // SAN strings
  const $tbody  = $('#move-list-body').empty();

  for (let i = 0; i < history.length; i += 2) {
    const n     = Math.floor(i / 2) + 1;
    const white = history[i]     || '';
    const black = history[i + 1] || '';
    const wCls  = (i === history.length - 1)     ? 'move-san last' : 'move-san';
    const bCls  = (i + 1 === history.length - 1) ? 'move-san last' : 'move-san';

    $tbody.append(
      `<tr>
        <td class="move-num">${n}.</td>
        <td class="${wCls}">${white}</td>
        <td class="${bCls}">${black}</td>
      </tr>`
    );
  }

  // Scroll to latest move
  const el = document.getElementById('move-list-container');
  el.scrollTop = el.scrollHeight;

  // chess.js 0.x pgn() options use snake_case
  $('#pgn-output').val(game.pgn({ max_width: 55, newline_char: '\n' }));
}

// ── Square Highlighting ────────────────────────────────────────────────────────
function addHighlight(square, cls) {
  $(`#board .square-${square}`).addClass(cls);
}

function clearHighlights() {
  hlSquares.forEach(sq => {
    $(`#board .square-${sq}`).removeClass('hl-move hl-capture hl-selected');
  });
  hlSquares = [];
}

function highlightLastMove() {
  $('.hl-last').removeClass('hl-last');
  if (!lastMove) return;
  addHighlight(lastMove.from, 'hl-last');
  addHighlight(lastMove.to,   'hl-last');
}

// ── Control Bindings ──────────────────────────────────────────────────────────
function bindControls() {
  $('#btn-new-game').on('click', startNewGame);

  $('#btn-flip').on('click', () => board && board.flip());

  $('#btn-undo').on('click', () => {
    if (gameMode === 'hvo') return; // no undo in online games
    if (!game || game.game_over() || aiThinking) return;
    game.undo();
    if (gameMode === 'hva') game.undo(); // also undo the AI's preceding move
    lastMove = null;
    board.position(game.fen());
    clearHighlights();
    highlightLastMove();
    updateStatus();
    renderMoveHistory();
  });

  $('#mode-select').on('change', function () {
    gameMode = $(this).val();
    $('#color-select-wrap').toggle(gameMode === 'hva');
    $('#room-panel').toggle(gameMode === 'hvo');
    if (gameMode === 'hvo') {
      showRoomLobby();
    } else {
      startNewGame();
    }
  });

  $('#color-select').on('change', function () {
    playerColor = $(this).val();
    startNewGame();
  });

  // ── Online room buttons ─────────────────────────────────────────────────

  $('#btn-create-room').on('click', () => {
    const roomId = Multiplayer.createRoom(
      // onOpponentJoined — game can start; creator plays White
      () => {
        myColor = 'w';
        showRoomActive(roomId, 'White');
        startOnlineGame('white');
      },
      // onMoveMade — apply opponent's move to our board
      (fen, lastMv) => applyRemoteMove(fen, lastMv),
      // onOpponentLeft — opponent closed their tab
      () => {
        roomActive = false;
        $('#status-bar').attr('class', 'draw');
        $('#status-text').text('Opponent disconnected.');
      }
    );
    showRoomWaiting(roomId);
  });

  $('#btn-copy-code').on('click', () => {
    navigator.clipboard.writeText($('#room-code-display').text());
  });

  $('#btn-join-room').on('click', () => {
    const code = $('#room-code-input').val().trim().toUpperCase();
    if (code.length !== 6) return;
    Multiplayer.joinRoom(
      code,
      (fen, lastMv) => applyRemoteMove(fen, lastMv),
      (msg) => {
        $('#status-bar').attr('class', 'check');
        $('#status-text').text(msg);
      },
      () => {
        roomActive = false;
        $('#status-bar').attr('class', 'draw');
        $('#status-text').text('Opponent disconnected.');
      }
    );
    myColor = 'b';
    showRoomActive(code, 'Black');
    startOnlineGame('black');
  });

  $('#btn-leave-room').on('click', () => {
    Multiplayer.leaveRoom();
    roomActive = false;
    gameMode = 'hvh';
    $('#mode-select').val('hvh');
    $('#room-panel').hide();
    startNewGame();
  });
}

// ── Online Multiplayer ────────────────────────────────────────────────────────

function startOnlineGame(orientation) {
  game       = new Chess();
  lastMove   = null;
  roomActive = true;
  hlSquares  = [];
  $('#promotion-modal').addClass('hidden');

  if (board) board.destroy();
  board = Chessboard('board', {
    draggable: true,
    position:  'start',
    orientation,
    pieceTheme: PIECE_THEME,
    onDragStart,
    onDrop,
    onSnapEnd,
    onMouseoverSquare,
    onMouseoutSquare,
  });

  updateStatus();
  renderMoveHistory();
  updateCapturedPieces();
}

/** Apply a move that arrived from Firebase (opponent moved). */
function applyRemoteMove(fen, lastMv) {
  game.load(fen);
  board.position(fen, false); // false = no animation (snap immediately)
  if (lastMv) {
    lastMove = lastMv;
    highlightLastMove();
  }
  updateStatus();
  renderMoveHistory();
  updateCapturedPieces();
}

// ── Room UI Helpers ───────────────────────────────────────────────────────────

function showRoomLobby() {
  if (board) { board.destroy(); board = null; }
  $('#room-lobby').show();
  $('#room-waiting').hide();
  $('#room-active').hide();
  $('#room-code-input').val('');
  $('#status-bar').attr('class', 'active');
  $('#status-text').text('Create a room or enter a code to join one.');
}

function showRoomWaiting(roomId) {
  $('#room-lobby').hide();
  $('#room-waiting').show();
  $('#room-active').hide();
  $('#room-code-display').text(roomId);
  $('#status-bar').attr('class', 'thinking');
  $('#status-text').text('Waiting for opponent\u2026');
}

function showRoomActive(roomId, colorName) {
  $('#room-lobby').hide();
  $('#room-waiting').hide();
  $('#room-active').show();
  $('#room-active-info').text(`Room\u00a0${roomId}\u2002\u2014\u2002You\u00a0are\u00a0${colorName}`);
}
