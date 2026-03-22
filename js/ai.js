/**
 * Chess AI — Minimax with Alpha-Beta Pruning + Piece-Square Tables
 *
 * Uses chess.js 0.x API (game_over, in_checkmate, in_draw, etc.)
 * Exposed as a global IIFE — no ES modules needed.
 */
const ChessAI = (() => {

  // Piece base values in centipawns
  const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

  /**
   * Piece-Square Tables (PST)
   * Each table is 64 entries from White's perspective:
   *   index 0-7   = rank 1 (a1..h1)
   *   index 56-63 = rank 8 (a8..h8)
   * For Black pieces the table is mirrored vertically.
   *
   * In chess.js 0.x board(), board[rankIdx][fileIdx]:
   *   rankIdx 0 = rank 8 (top), rankIdx 7 = rank 1 (bottom)
   *
   * So:  white pstIdx = (7 - rankIdx) * 8 + fileIdx
   *      black pstIdx =      rankIdx  * 8 + fileIdx
   */
  const PST = {
    p: [
       0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
       5,  5, 10, 25, 25, 10,  5,  5,
       0,  0,  0, 20, 20,  0,  0,  0,
       5, -5,-10,  0,  0,-10, -5,  5,
       5, 10, 10,-20,-20, 10, 10,  5,
       0,  0,  0,  0,  0,  0,  0,  0,
    ],
    n: [
      -50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50,
    ],
    b: [
      -20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20,
    ],
    r: [
       0,  0,  0,  0,  0,  0,  0,  0,
       5, 10, 10, 10, 10, 10, 10,  5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
       0,  0,  0,  5,  5,  0,  0,  0,
    ],
    q: [
      -20,-10,-10, -5, -5,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5,  5,  5,  5,  0,-10,
       -5,  0,  5,  5,  5,  5,  0, -5,
        0,  0,  5,  5,  5,  5,  0, -5,
      -10,  5,  5,  5,  5,  5,  0,-10,
      -10,  0,  5,  0,  0,  0,  0,-10,
      -20,-10,-10, -5, -5,-10,-10,-20,
    ],
    k: {
      middle: [
        -30,-40,-40,-50,-50,-40,-40,-30,
        -30,-40,-40,-50,-50,-40,-40,-30,
        -30,-40,-40,-50,-50,-40,-40,-30,
        -30,-40,-40,-50,-50,-40,-40,-30,
        -20,-30,-30,-40,-40,-30,-30,-20,
        -10,-20,-20,-20,-20,-20,-20,-10,
         20, 20,  0,  0,  0,  0, 20, 20,
         20, 30, 10,  0,  0, 10, 30, 20,
      ],
      end: [
        -50,-40,-30,-20,-20,-30,-40,-50,
        -30,-20,-10,  0,  0,-10,-20,-30,
        -30,-10, 20, 30, 30, 20,-10,-30,
        -30,-10, 30, 40, 40, 30,-10,-30,
        -30,-10, 30, 40, 40, 30,-10,-30,
        -30,-10, 20, 30, 30, 20,-10,-30,
        -30,-30,  0,  0,  0,  0,-30,-30,
        -50,-30,-30,-30,-30,-30,-30,-50,
      ],
    },
  };

  /** True when we should use the endgame king table */
  function isEndgame(chess) {
    let queens = 0, minors = 0;
    chess.board().forEach(row => row.forEach(sq => {
      if (!sq) return;
      if (sq.type === 'q') queens++;
      if (sq.type === 'n' || sq.type === 'b') minors++;
    }));
    return queens === 0 || (queens === 2 && minors <= 2);
  }

  /**
   * Static evaluation in centipawns from White's perspective.
   * Positive = White advantage; negative = Black advantage.
   */
  function evaluate(chess) {
    // chess.js 0.x API
    if (chess.in_checkmate()) return chess.turn() === 'w' ? -99999 : 99999;
    if (chess.in_draw())      return 0;

    const eg = isEndgame(chess);
    let score = 0;

    chess.board().forEach((row, rankIdx) => {
      row.forEach((piece, fileIdx) => {
        if (!piece) return;

        // Map board position to PST index
        // chess.js board: rankIdx 0 = rank 8, rankIdx 7 = rank 1
        const pstIdx = piece.color === 'w'
          ? (7 - rankIdx) * 8 + fileIdx   // rank 1 at index 0
          : rankIdx       * 8 + fileIdx;  // mirrored for Black

        const table = piece.type === 'k'
          ? (eg ? PST.k.end : PST.k.middle)
          : PST[piece.type];

        score += (piece.color === 'w' ? 1 : -1) * (PIECE_VALUES[piece.type] + table[pstIdx]);
      });
    });

    return score;
  }

  /** Minimax with alpha-beta pruning (chess.js 0.x API) */
  function minimax(chess, depth, alpha, beta, maximizing) {
    if (depth === 0 || chess.game_over()) {
      return evaluate(chess);
    }

    const moves = chess.moves();

    if (maximizing) {
      let best = -Infinity;
      for (const move of moves) {
        chess.move(move);
        best = Math.max(best, minimax(chess, depth - 1, alpha, beta, false));
        chess.undo();
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const move of moves) {
        chess.move(move);
        best = Math.min(best, minimax(chess, depth - 1, alpha, beta, true));
        chess.undo();
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  /**
   * Returns the best SAN move string for the current position.
   * @param {Chess} chess  - chess.js 0.x instance
   * @param {number} depth - search depth (default 3)
   */
  function getBestMove(chess, depth = 3) {
    const moves = chess.moves();
    if (!moves.length) return null;

    const maximizing = chess.turn() === 'w';
    let bestMove  = null;
    let bestScore = maximizing ? -Infinity : Infinity;

    // Shuffle to avoid repeating the same move in equal positions
    const shuffled = moves.slice().sort(() => Math.random() - 0.5);

    for (const move of shuffled) {
      chess.move(move);
      const score = minimax(chess, depth - 1, -Infinity, Infinity, !maximizing);
      chess.undo();

      if (maximizing ? score > bestScore : score < bestScore) {
        bestScore = score;
        bestMove  = move;
      }
    }

    return bestMove;
  }

  return { getBestMove };
})();
