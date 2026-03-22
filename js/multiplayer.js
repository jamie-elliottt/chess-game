/**
 * Multiplayer module — Firebase Realtime Database sync layer.
 *
 * Exposes a single global: Multiplayer
 *   .init(firebaseConfig)
 *   .createRoom(onOpponentJoined, onMoveMade, onOpponentLeft) → roomId
 *   .joinRoom(roomId, onMoveMade, onError, onOpponentLeft)
 *   .sendMove(fen, from, to)
 *   .leaveRoom()
 *
 * Room syncing strategy: after each move the full FEN is written to Firebase.
 * Each client listens for changes and applies the new FEN when it's their turn
 * to receive (i.e. when the stored turn colour matches their own colour,
 * meaning the opponent just moved).
 */
const Multiplayer = (() => {
  let db      = null;
  let roomRef = null;

  // Characters that are easy to read aloud / distinguish visually
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function generateRoomId() {
    return Array.from({ length: 6 }, () =>
      CHARS[Math.floor(Math.random() * CHARS.length)]
    ).join('');
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  function init(config) {
    firebase.initializeApp(config);
    db = firebase.database();
  }

  /**
   * Create a new room. The creator always plays White.
   * Returns the 6-char room ID immediately (before the opponent joins).
   */
  function createRoom(onOpponentJoined, onMoveMade, onOpponentLeft) {
    const roomId = generateRoomId();
    roomRef = db.ref('rooms/' + roomId);

    roomRef.set({
      fen:    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      turn:   'w',
      status: 'waiting',
    });

    // If this tab closes unexpectedly, mark the room abandoned
    roomRef.onDisconnect().update({ status: 'abandoned' });

    let prevStatus = 'waiting';
    roomRef.on('value', snap => {
      const data = snap.val();
      if (!data) return;

      // Opponent disconnected
      if (data.status === 'abandoned' && prevStatus !== 'abandoned') {
        prevStatus = 'abandoned';
        onOpponentLeft && onOpponentLeft();
        return;
      }

      // Opponent just joined — start the game
      if (prevStatus === 'waiting' && data.status === 'active') {
        prevStatus = 'active';
        onOpponentJoined();
        return;
      }

      prevStatus = data.status;

      // Creator is White. turn === 'w' means Black (opponent) just moved.
      if (data.status === 'active' && data.turn === 'w' && data.lastMove) {
        onMoveMade(data.fen, data.lastMove);
      }
    });

    return roomId;
  }

  /**
   * Join an existing room by its 6-char ID. The joiner always plays Black.
   */
  function joinRoom(roomId, onMoveMade, onError, onOpponentLeft) {
    roomRef = db.ref('rooms/' + roomId);

    roomRef.once('value', snap => {
      const data = snap.val();
      if (!data || data.status !== 'waiting') {
        onError('Room not found or already started.');
        roomRef = null;
        return;
      }

      roomRef.update({ status: 'active' });
      roomRef.onDisconnect().update({ status: 'abandoned' });

      // Skip the first listener fire (the state we just read)
      let initialized = false;
      roomRef.on('value', snap2 => {
        const d = snap2.val();
        if (!d) return;
        if (!initialized) { initialized = true; return; }

        if (d.status === 'abandoned') {
          onOpponentLeft && onOpponentLeft();
          return;
        }

        // Joiner is Black. turn === 'b' means White (opponent) just moved.
        if (d.status === 'active' && d.turn === 'b' && d.lastMove) {
          onMoveMade(d.fen, d.lastMove);
        }
      });
    });
  }

  /**
   * Publish a move to Firebase after making it locally.
   * `fen` is the game state AFTER the move; `from`/`to` are for highlight sync.
   */
  function sendMove(fen, from, to) {
    if (!roomRef) return;
    const turn = fen.split(' ')[1]; // 'w' or 'b' — whose turn it is next
    roomRef.update({ fen, turn, lastMove: { from, to }, status: 'active' });
  }

  /**
   * Cleanly leave the room (marks it abandoned so the opponent is notified).
   */
  function leaveRoom() {
    if (!roomRef) return;
    roomRef.update({ status: 'abandoned' });
    roomRef.off();
    roomRef.onDisconnect().cancel();
    roomRef = null;
  }

  return { init, createRoom, joinRoom, sendMove, leaveRoom };
})();
