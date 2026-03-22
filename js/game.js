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
let gameMode    = 'hvh'; // 'hvh' | 'hva'
let playerColor = 'w';   // human's color in hva mode
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
  // hva: only allow the human's pieces on the human's turn
  return pieceColor === playerColor && game.turn() === playerColor;
}

function onMouseoverSquare(square, piece) {
  if (game.game_over() || aiThinking || !piece) return;

  const pieceColor = piece[0];
  if (pieceColor !== game.turn()) return;
  if (gameMode === 'hva' && pieceColor !== playerColor) return;

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
}

// ── Post-Move Orchestration ────────────────────────────────────────────────────
function afterMove() {
  updateStatus();
  renderMoveHistory();

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
  }, 50);
}

// ── UI Updates ─────────────────────────────────────────────────────────────────
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
    if (game.game_over() || aiThinking) return;
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
    startNewGame();
  });

  $('#color-select').on('change', function () {
    playerColor = $(this).val();
    startNewGame();
  });
}
