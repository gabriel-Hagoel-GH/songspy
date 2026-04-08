const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 8888;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Game State ────────────────────────────────────────────
const rooms = {}; // roomCode -> room object

function makeRoom(hostId, hostName) {
  const code = Math.random().toString(36).slice(2,6).toUpperCase();
  rooms[code] = {
    code,
    hostId,
    phase: 'lobby',      // lobby | playing | revealing | gameover
    players: {},         // socketId -> { name, score, guess, artistGuess, guessedCorrectly }
    songs: [],
    currentSongIdx: 0,
    currentAttempt: 0,
    currentSong: null,
    roundCount: 5,
    timerEnd: null,
    timerInterval: null,
    selectedGenres: [],
    selectedDecades: [],
    israeliMode: false,
    playPosition: 'middle',
  };
  rooms[code].players[hostId] = { name: hostName, score: 0, isHost: true, guess: '', artistGuess: '', guessedCorrectly: false };
  return rooms[code];
}

function getRoomOf(socketId) {
  return Object.values(rooms).find(r => r.players[socketId]);
}

function roomPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, score: p.score, isHost: p.isHost,
    guessedCorrectly: p.guessedCorrectly
  }));
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', {
    phase: room.phase,
    players: roomPlayers(room),
    currentSongIdx: room.currentSongIdx,
    roundCount: room.roundCount,
    currentAttempt: room.currentAttempt,
    songCount: room.songs.length,
  });
}

// ── Fuzzy Match ───────────────────────────────────────────
function cleanStr(s) {
  return s
    .replace(/\s*[-\[(|]\s*.*(remaster|remix|edit|live|version|acoustic|radio|mono|stereo|original|anniversary|deluxe|feat|ft\.|with ).*/gi, '')
    .replace(/\s*\(\d{4}\)\s*/g, '')
    .replace(/[^\u05d0-\u05ea\u05f0-\u05f4a-zA-Z0-9 ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function fuzzyMatch(guess, actual) {
  const g = cleanStr(guess), a = cleanStr(actual);
  if (!g) return false;
  if (g === a || a.includes(g) || g.includes(a)) return true;
  const gWords = g.split(' ').filter(w => w.length > 1);
  const needed = gWords.length <= 2 ? 1 : Math.ceil(gWords.length * 0.5);
  return gWords.filter(w => a.includes(w)).length >= needed;
}

// ── Timer ─────────────────────────────────────────────────
const DURS = [10, 20, 30, 40, 50];
const POINTS = [10, 8, 6, 4, 2];
const MAX_ATTEMPTS = 5;

function startTimer(room, duration) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  const end = Date.now() + duration * 1000;
  room.timerEnd = end;

  io.to(room.code).emit('timer_start', { duration, end });

  room.timerInterval = setInterval(() => {
    const remaining = Math.ceil((room.timerEnd - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      onTimerEnd(room);
    }
  }, 500);
}

function onTimerEnd(room) {
  // Check if anyone got it
  const winners = Object.values(room.players).filter(p => p.guessedCorrectly);
  if (winners.length > 0) return; // already revealed

  // No one guessed — go to next attempt or reveal
  room.currentAttempt++;
  if (room.currentAttempt >= MAX_ATTEMPTS) {
    revealSong(room, false);
  } else {
    // Tell host to play longer clip
    io.to(room.code).emit('play_longer', {
      attempt: room.currentAttempt,
      duration: DURS[room.currentAttempt]
    });
    broadcastRoom(room);
    startTimer(room, DURS[room.currentAttempt]);
  }
}

function revealSong(room, won) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
  room.phase = 'revealing';

  const song = room.currentSong;
  io.to(room.code).emit('reveal', {
    won,
    song: { title: song.title, artist: song.artist, id: song.id, albumArt: song.albumArt, releaseYear: song.releaseYear },
    players: roomPlayers(room),
    attempt: room.currentAttempt,
    isLast: room.currentSongIdx >= room.roundCount - 1,
  });
}

// ── Socket Events ─────────────────────────────────────────
io.on('connection', (socket) => {

  // Create room (host)
  socket.on('create_room', ({ name }) => {
    const room = makeRoom(socket.id, name);
    socket.join(room.code);
    socket.emit('room_created', { code: room.code, playerId: socket.id });
    broadcastRoom(room);
  });

  // Join room (player)
  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.phase !== 'lobby') { socket.emit('error', 'Game already started'); return; }
    if (Object.keys(room.players).length >= 10) { socket.emit('error', 'Room is full'); return; }

    room.players[socket.id] = { name, score: 0, isHost: false, guess: '', artistGuess: '', guessedCorrectly: false };
    socket.join(code.toUpperCase());
    socket.emit('room_joined', { code: code.toUpperCase(), playerId: socket.id });
    broadcastRoom(room);
    io.to(room.code).emit('player_joined', { name });
  });

  // Host sets game config
  socket.on('set_config', ({ roundCount, selectedGenres, selectedDecades, israeliMode, playPosition }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.roundCount = roundCount;
    room.selectedGenres = selectedGenres;
    room.selectedDecades = selectedDecades;
    room.israeliMode = israeliMode;
    room.playPosition = playPosition;
    broadcastRoom(room);
  });

  // Host sends fetched songs
  socket.on('songs_ready', ({ songs }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.songs = songs.slice(0, room.roundCount);
    room.currentSongIdx = 0;
    room.currentAttempt = 0;
    room.phase = 'playing';
    room.currentSong = room.songs[0];

    // Reset all player guesses
    Object.values(room.players).forEach(p => { p.guess = ''; p.artistGuess = ''; p.guessedCorrectly = false; });

    io.to(room.code).emit('game_start', {
      song: null, // don't reveal song info yet
      roundCount: room.roundCount,
      playPosition: room.playPosition,
    });
    broadcastRoom(room);
    startTimer(room, DURS[0]);
  });

  // Host signals song is playing (for sync)
  socket.on('song_playing', ({ attempt }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    io.to(room.code).emit('song_playing', { attempt, duration: DURS[attempt] });
  });

  // Player submits guess
  socket.on('submit_guess', ({ titleGuess, artistGuess }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.phase !== 'playing') return;

    const player = room.players[socket.id];
    if (!player || player.guessedCorrectly) return;

    const song = room.currentSong;
    const titleCorrect = titleGuess && fuzzyMatch(titleGuess, song.title);
    const artistCorrect = artistGuess && fuzzyMatch(artistGuess, song.artist);

    if (!titleCorrect && !artistCorrect) {
      socket.emit('guess_result', { correct: false, message: 'Not quite! Try again.' });
      return;
    }

    // Award points
    let pts = 0, parts = [];
    if (titleCorrect) { pts += POINTS[room.currentAttempt] || 2; parts.push('song ✓'); }
    if (artistCorrect) { pts += Math.ceil((POINTS[room.currentAttempt] || 2) / 2); parts.push('artist ✓'); }

    player.score += pts;
    player.guessedCorrectly = true;

    socket.emit('guess_result', { correct: true, pts, message: parts.join(' + ') });
    io.to(room.code).emit('player_guessed', { name: player.name, pts });
    broadcastRoom(room);

    // Check if ALL players guessed correctly
    const allGuessed = Object.values(room.players).every(p => p.guessedCorrectly);
    if (allGuessed) {
      // Short delay so everyone sees the last guess notification
      setTimeout(() => revealSong(room, true), 1500);
    }
  });

  // Host moves to next song
  socket.on('next_song', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;

    room.currentSongIdx++;
    if (room.currentSongIdx >= room.roundCount || room.currentSongIdx >= room.songs.length) {
      room.phase = 'gameover';
      io.to(room.code).emit('game_over', { players: roomPlayers(room) });
      broadcastRoom(room);
      return;
    }

    room.currentSong = room.songs[room.currentSongIdx];
    room.currentAttempt = 0;
    room.phase = 'playing';
    Object.values(room.players).forEach(p => { p.guess = ''; p.artistGuess = ''; p.guessedCorrectly = false; });

    io.to(room.code).emit('next_song', {
      songIdx: room.currentSongIdx,
      roundCount: room.roundCount,
      playPosition: room.playPosition,
    });
    broadcastRoom(room);
    startTimer(room, DURS[0]);
  });

  // Host plays again (new game)
  socket.on('play_again', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'lobby';
    room.songs = [];
    room.currentSongIdx = 0;
    room.currentAttempt = 0;
    room.currentSong = null;
    Object.values(room.players).forEach(p => { p.score = 0; p.guess = ''; p.artistGuess = ''; p.guessedCorrectly = false; });
    io.to(room.code).emit('back_to_lobby');
    broadcastRoom(room);
  });

  // Skip current song
  socket.on('skip_song', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    revealSong(room, false);
  });

  // End game early
  socket.on('end_game', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
    room.phase = 'gameover';
    io.to(room.code).emit('game_over', { players: roomPlayers(room) });
    broadcastRoom(room);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = getRoomOf(socket.id);
    if (!room) return;
    const player = room.players[socket.id];
    const name = player?.name;
    delete room.players[socket.id];

    if (room.hostId === socket.id) {
      // Host left — end game
      io.to(room.code).emit('host_left');
      if (room.timerInterval) clearInterval(room.timerInterval);
      delete rooms[room.code];
    } else {
      io.to(room.code).emit('player_left', { name });
      broadcastRoom(room);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🎵 SongSpy Multiplayer running on port ${PORT}\n`);
});
