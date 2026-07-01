use std::env;
use std::io::{self, BufRead, Write};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

const EMPTY: u8 = 0;
const P: u8 = 1;
const N: u8 = 2;
const B: u8 = 3;
const R: u8 = 4;
const Q: u8 = 5;
const K: u8 = 6;
const BLACK: u8 = 8;

const WHITE: u8 = 0;
const BLACK_SIDE: u8 = 1;

const CASTLE_WK: u8 = 1;
const CASTLE_WQ: u8 = 2;
const CASTLE_BK: u8 = 4;
const CASTLE_BQ: u8 = 8;

const FLAG_EP: u8 = 1;
const FLAG_CASTLE: u8 = 2;

const MATE: i32 = 1_000_000;
const INF: i32 = MATE * 2;
const DEFAULT_HASH_MB: usize = 16;
const MAX_SEARCH_PLY: usize = 128;
const MOVE_KEY_COUNT: usize = 64 * 64;
const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const SPEED_CASES: [(&str, &str); 5] = [
    ("startpos", START_FEN),
    (
        "kiwipete",
        "r3k2r/p1ppqpb1/bn2pnp1/2PpP3/1p2P3/2N2N2/PPQPBPPP/R3K2R w KQkq - 0 1",
    ),
    (
        "hanging queen",
        "rnb1kbnr/pppp1ppp/8/3qp3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3",
    ),
    (
        "queen trap",
        "rnbqkbnr/pp2pppp/2p5/3p4/8/3Q4/PPPP1PPP/RNB1KBNR w KQkq - 0 1",
    ),
    ("rook endgame", "8/5pk1/6p1/8/8/6P1/5PK1/4R3 w - - 0 1"),
];

#[derive(Clone, Copy)]
struct Board {
    squares: [u8; 64],
    side: u8,
    castling: u8,
    ep: i8,
    halfmove: u16,
    fullmove: u16,
    kings: [u8; 2],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Move {
    from: u8,
    to: u8,
    promo: u8,
    flags: u8,
}

struct MoveList {
    moves: [Move; 256],
    len: usize,
}

impl MoveList {
    fn new() -> Self {
        Self {
            moves: [Move::default(); 256],
            len: 0,
        }
    }

    fn clear(&mut self) {
        self.len = 0;
    }

    fn push(&mut self, mv: Move) {
        self.moves[self.len] = mv;
        self.len += 1;
    }

    fn as_slice(&self) -> &[Move] {
        &self.moves[..self.len]
    }

    fn as_mut_slice(&mut self) -> &mut [Move] {
        &mut self.moves[..self.len]
    }
}

#[derive(Clone)]
struct SearchResult {
    best_move: Option<Move>,
    score_cp: i32,
    pv: Vec<Move>,
    multi_pv: Vec<PvLine>,
    depth: u8,
    seldepth: u8,
    nodes: u64,
    hashfull: u16,
    elapsed_ms: u128,
    nps: u64,
    aborted: bool,
    abort_reason: Option<&'static str>,
}

#[derive(Clone)]
struct PvLine {
    root: Move,
    score_cp: i32,
    pv: Vec<Move>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Bound {
    Exact,
    Lower,
    Upper,
}

#[derive(Clone, Copy)]
struct TtEntry {
    key: u64,
    depth: i32,
    score: i32,
    bound: Bound,
    best_move: Option<Move>,
}

struct TranspositionTable {
    entries: Vec<Option<TtEntry>>,
    used: usize,
}

impl TranspositionTable {
    fn new(hash_mb: usize) -> Self {
        let bytes = hash_mb.max(1).saturating_mul(1024 * 1024);
        let entry_size = std::mem::size_of::<Option<TtEntry>>().max(1);
        let size = (bytes / entry_size).max(1024).next_power_of_two();
        Self {
            entries: vec![None; size],
            used: 0,
        }
    }

    fn probe(&self, key: u64) -> Option<TtEntry> {
        let entry = self.entries[self.index(key)]?;
        if entry.key == key { Some(entry) } else { None }
    }

    fn store(&mut self, key: u64, depth: i32, score: i32, bound: Bound, best_move: Option<Move>) {
        let idx = self.index(key);
        if let Some(existing) = self.entries[idx] {
            if existing.key == key && existing.depth > depth {
                return;
            }
        }
        if self.entries[idx].is_none() {
            self.used += 1;
        }
        self.entries[idx] = Some(TtEntry {
            key,
            depth,
            score,
            bound,
            best_move,
        });
    }

    fn hashfull(&self) -> u16 {
        ((self.used * 1000) / self.entries.len()).min(1000) as u16
    }

    fn index(&self, key: u64) -> usize {
        key as usize & (self.entries.len() - 1)
    }
}

struct SearchState {
    started: Instant,
    deadline: Option<Instant>,
    max_nodes: Option<u64>,
    stop: Option<Arc<AtomicBool>>,
    nodes: u64,
    seldepth: u8,
    aborted: bool,
    abort_reason: Option<&'static str>,
    tt: TranspositionTable,
    killers: [[Option<Move>; 2]; MAX_SEARCH_PLY],
    history: [i32; MOVE_KEY_COUNT],
    countermoves: [Option<Move>; MOVE_KEY_COUNT],
}

impl SearchState {
    fn new(
        max_time_ms: Option<u64>,
        max_nodes: Option<u64>,
        hash_mb: usize,
        stop: Option<Arc<AtomicBool>>,
    ) -> Self {
        let started = Instant::now();
        Self {
            started,
            deadline: max_time_ms.map(|ms| started + Duration::from_millis(ms)),
            max_nodes,
            stop,
            nodes: 0,
            seldepth: 0,
            aborted: false,
            abort_reason: None,
            tt: TranspositionTable::new(hash_mb),
            killers: [[None; 2]; MAX_SEARCH_PLY],
            history: [0; MOVE_KEY_COUNT],
            countermoves: [None; MOVE_KEY_COUNT],
        }
    }

    fn should_stop(&mut self) -> bool {
        if self.aborted {
            return true;
        }
        if self
            .stop
            .as_ref()
            .is_some_and(|stop| stop.load(Ordering::Relaxed))
        {
            self.aborted = true;
            self.abort_reason = Some("stop");
            return true;
        }
        if let Some(max_nodes) = self.max_nodes {
            if self.nodes >= max_nodes {
                self.aborted = true;
                self.abort_reason = Some("nodes");
                return true;
            }
        }
        if let Some(deadline) = self.deadline {
            if (self.nodes & 4095) == 0 && Instant::now() >= deadline {
                self.aborted = true;
                self.abort_reason = Some("time");
                return true;
            }
        }
        false
    }
}

impl Board {
    fn from_fen(fen: &str) -> Result<Self, String> {
        let parts: Vec<&str> = fen.split_whitespace().collect();
        if parts.len() < 4 {
            return Err("invalid FEN: expected at least 4 fields".to_string());
        }

        let mut board = Board {
            squares: [EMPTY; 64],
            side: WHITE,
            castling: 0,
            ep: -1,
            halfmove: 0,
            fullmove: 1,
            kings: [64, 64],
        };

        let rows: Vec<&str> = parts[0].split('/').collect();
        if rows.len() != 8 {
            return Err("invalid FEN: board must have 8 ranks".to_string());
        }

        for (row_idx, row) in rows.iter().enumerate() {
            let rank = 7usize.saturating_sub(row_idx);
            let mut file = 0usize;
            for ch in row.chars() {
                if ch.is_ascii_digit() {
                    file += ch.to_digit(10).unwrap() as usize;
                    continue;
                }
                if file >= 8 {
                    return Err("invalid FEN: too many files".to_string());
                }
                let piece = piece_from_fen(ch)?;
                let sq = rank * 8 + file;
                board.squares[sq] = piece;
                if kind(piece) == K {
                    board.kings[color(piece) as usize] = sq as u8;
                }
                file += 1;
            }
            if file != 8 {
                return Err("invalid FEN: rank does not contain 8 files".to_string());
            }
        }

        board.side = match parts[1] {
            "w" => WHITE,
            "b" => BLACK_SIDE,
            _ => return Err("invalid FEN: side to move must be w or b".to_string()),
        };

        if parts[2].contains('K') {
            board.castling |= CASTLE_WK;
        }
        if parts[2].contains('Q') {
            board.castling |= CASTLE_WQ;
        }
        if parts[2].contains('k') {
            board.castling |= CASTLE_BK;
        }
        if parts[2].contains('q') {
            board.castling |= CASTLE_BQ;
        }

        board.ep = if parts[3] == "-" {
            -1
        } else {
            square_from_text(parts[3])
                .ok_or_else(|| "invalid FEN: bad en-passant square".to_string())? as i8
        };
        if parts.len() > 4 {
            board.halfmove = parts[4].parse::<u16>().unwrap_or(0);
        }
        if parts.len() > 5 {
            board.fullmove = parts[5].parse::<u16>().unwrap_or(1).max(1);
        }

        if board.kings[0] >= 64 || board.kings[1] >= 64 {
            return Err("invalid FEN: missing king".to_string());
        }

        Ok(board)
    }

    fn legal_moves(&self, out: &mut MoveList) {
        let us = self.side;
        let mut pseudo = MoveList::new();
        self.pseudo_moves(&mut pseudo);
        out.clear();
        for mv in pseudo.as_slice() {
            let mut child = *self;
            child.make_move(*mv);
            if !child.in_check(us) {
                out.push(*mv);
            }
        }
    }

    fn pseudo_moves(&self, out: &mut MoveList) {
        out.clear();
        for sq in 0..64u8 {
            let piece = self.squares[sq as usize];
            if piece == EMPTY || color(piece) != self.side {
                continue;
            }
            match kind(piece) {
                P => self.pawn_moves(out, sq, piece),
                N => self.step_moves(out, sq, piece, &KNIGHT_STEPS),
                B => self.slider_moves(out, sq, piece, &BISHOP_STEPS),
                R => self.slider_moves(out, sq, piece, &ROOK_STEPS),
                Q => self.slider_moves(out, sq, piece, &QUEEN_STEPS),
                K => {
                    self.step_moves(out, sq, piece, &KING_STEPS);
                    self.castle_moves(out, sq);
                }
                _ => {}
            }
        }
    }

    fn pawn_moves(&self, out: &mut MoveList, sq: u8, piece: u8) {
        let file = file_of(sq);
        let rank = rank_of(sq);
        let side = color(piece);
        if side == WHITE {
            if rank < 7 {
                let one = sq + 8;
                if self.squares[one as usize] == EMPTY {
                    if rank == 6 {
                        self.add_promotions(out, sq, one);
                    } else {
                        out.push(Move {
                            from: sq,
                            to: one,
                            promo: 0,
                            flags: 0,
                        });
                        if rank == 1 {
                            let two = sq + 16;
                            if self.squares[two as usize] == EMPTY {
                                out.push(Move {
                                    from: sq,
                                    to: two,
                                    promo: 0,
                                    flags: 0,
                                });
                            }
                        }
                    }
                }
            }
            if file > 0 {
                self.pawn_capture(out, sq, sq + 7, rank == 6);
            }
            if file < 7 {
                self.pawn_capture(out, sq, sq + 9, rank == 6);
            }
        } else {
            if rank > 0 {
                let one = sq - 8;
                if self.squares[one as usize] == EMPTY {
                    if rank == 1 {
                        self.add_promotions(out, sq, one);
                    } else {
                        out.push(Move {
                            from: sq,
                            to: one,
                            promo: 0,
                            flags: 0,
                        });
                        if rank == 6 {
                            let two = sq - 16;
                            if self.squares[two as usize] == EMPTY {
                                out.push(Move {
                                    from: sq,
                                    to: two,
                                    promo: 0,
                                    flags: 0,
                                });
                            }
                        }
                    }
                }
            }
            if file > 0 {
                self.pawn_capture(out, sq, sq - 9, rank == 1);
            }
            if file < 7 {
                self.pawn_capture(out, sq, sq - 7, rank == 1);
            }
        }
    }

    fn pawn_capture(&self, out: &mut MoveList, from: u8, to: u8, promotes: bool) {
        let target = self.squares[to as usize];
        if target != EMPTY && color(target) != self.side {
            if promotes {
                self.add_promotions(out, from, to);
            } else {
                out.push(Move {
                    from,
                    to,
                    promo: 0,
                    flags: 0,
                });
            }
        } else if self.ep == to as i8 {
            out.push(Move {
                from,
                to,
                promo: 0,
                flags: FLAG_EP,
            });
        }
    }

    fn add_promotions(&self, out: &mut MoveList, from: u8, to: u8) {
        for promo in [Q, R, B, N] {
            out.push(Move {
                from,
                to,
                promo,
                flags: 0,
            });
        }
    }

    fn step_moves(&self, out: &mut MoveList, sq: u8, piece: u8, steps: &[(i8, i8)]) {
        let f = file_of(sq) as i8;
        let r = rank_of(sq) as i8;
        for (df, dr) in steps {
            let nf = f + df;
            let nr = r + dr;
            if !on_board(nf, nr) {
                continue;
            }
            let to = index(nf, nr);
            let target = self.squares[to as usize];
            if target == EMPTY || color(target) != color(piece) {
                out.push(Move {
                    from: sq,
                    to,
                    promo: 0,
                    flags: 0,
                });
            }
        }
    }

    fn slider_moves(&self, out: &mut MoveList, sq: u8, piece: u8, steps: &[(i8, i8)]) {
        let f = file_of(sq) as i8;
        let r = rank_of(sq) as i8;
        for (df, dr) in steps {
            let mut nf = f + df;
            let mut nr = r + dr;
            while on_board(nf, nr) {
                let to = index(nf, nr);
                let target = self.squares[to as usize];
                if target == EMPTY {
                    out.push(Move {
                        from: sq,
                        to,
                        promo: 0,
                        flags: 0,
                    });
                } else {
                    if color(target) != color(piece) {
                        out.push(Move {
                            from: sq,
                            to,
                            promo: 0,
                            flags: 0,
                        });
                    }
                    break;
                }
                nf += df;
                nr += dr;
            }
        }
    }

    fn castle_moves(&self, out: &mut MoveList, sq: u8) {
        if self.in_check(self.side) {
            return;
        }
        if self.side == WHITE && sq == 4 {
            if (self.castling & CASTLE_WK) != 0
                && self.squares[5] == EMPTY
                && self.squares[6] == EMPTY
                && self.squares[7] == piece(WHITE, R)
                && !self.is_attacked(5, BLACK_SIDE)
                && !self.is_attacked(6, BLACK_SIDE)
            {
                out.push(Move {
                    from: 4,
                    to: 6,
                    promo: 0,
                    flags: FLAG_CASTLE,
                });
            }
            if (self.castling & CASTLE_WQ) != 0
                && self.squares[3] == EMPTY
                && self.squares[2] == EMPTY
                && self.squares[1] == EMPTY
                && self.squares[0] == piece(WHITE, R)
                && !self.is_attacked(3, BLACK_SIDE)
                && !self.is_attacked(2, BLACK_SIDE)
            {
                out.push(Move {
                    from: 4,
                    to: 2,
                    promo: 0,
                    flags: FLAG_CASTLE,
                });
            }
        } else if self.side == BLACK_SIDE && sq == 60 {
            if (self.castling & CASTLE_BK) != 0
                && self.squares[61] == EMPTY
                && self.squares[62] == EMPTY
                && self.squares[63] == piece(BLACK_SIDE, R)
                && !self.is_attacked(61, WHITE)
                && !self.is_attacked(62, WHITE)
            {
                out.push(Move {
                    from: 60,
                    to: 62,
                    promo: 0,
                    flags: FLAG_CASTLE,
                });
            }
            if (self.castling & CASTLE_BQ) != 0
                && self.squares[59] == EMPTY
                && self.squares[58] == EMPTY
                && self.squares[57] == EMPTY
                && self.squares[56] == piece(BLACK_SIDE, R)
                && !self.is_attacked(59, WHITE)
                && !self.is_attacked(58, WHITE)
            {
                out.push(Move {
                    from: 60,
                    to: 58,
                    promo: 0,
                    flags: FLAG_CASTLE,
                });
            }
        }
    }

    fn make_move(&mut self, mv: Move) {
        let moving = self.squares[mv.from as usize];
        let captured = self.squares[mv.to as usize];
        let us = color(moving);
        let them = us ^ 1;
        let moving_kind = kind(moving);

        self.squares[mv.from as usize] = EMPTY;
        if (mv.flags & FLAG_EP) != 0 {
            let cap_sq = if us == WHITE { mv.to - 8 } else { mv.to + 8 };
            self.squares[cap_sq as usize] = EMPTY;
        }

        if moving_kind == K {
            self.kings[us as usize] = mv.to;
            if us == WHITE {
                self.castling &= !(CASTLE_WK | CASTLE_WQ);
            } else {
                self.castling &= !(CASTLE_BK | CASTLE_BQ);
            }
            if (mv.flags & FLAG_CASTLE) != 0 {
                match (mv.from, mv.to) {
                    (4, 6) => {
                        self.squares[7] = EMPTY;
                        self.squares[5] = piece(WHITE, R);
                    }
                    (4, 2) => {
                        self.squares[0] = EMPTY;
                        self.squares[3] = piece(WHITE, R);
                    }
                    (60, 62) => {
                        self.squares[63] = EMPTY;
                        self.squares[61] = piece(BLACK_SIDE, R);
                    }
                    (60, 58) => {
                        self.squares[56] = EMPTY;
                        self.squares[59] = piece(BLACK_SIDE, R);
                    }
                    _ => {}
                }
            }
        }

        if moving_kind == R {
            self.clear_rook_castle(mv.from);
        }
        if captured != EMPTY && kind(captured) == R {
            self.clear_rook_castle(mv.to);
        }

        let placed = if mv.promo != 0 {
            piece(us, mv.promo)
        } else {
            moving
        };
        self.squares[mv.to as usize] = placed;

        self.ep = -1;
        if moving_kind == P && (mv.from as i16 - mv.to as i16).abs() == 16 {
            self.ep = if us == WHITE {
                (mv.from + 8) as i8
            } else {
                (mv.from - 8) as i8
            };
        }

        self.halfmove = if moving_kind == P || captured != EMPTY || (mv.flags & FLAG_EP) != 0 {
            0
        } else {
            self.halfmove + 1
        };
        if us == BLACK_SIDE {
            self.fullmove += 1;
        }
        self.side = them;
    }

    fn null_move(&self) -> Self {
        let mut board = *self;
        board.side ^= 1;
        board.ep = -1;
        board.halfmove = board.halfmove.saturating_add(1);
        board
    }

    fn has_non_pawn_material(&self, side: u8) -> bool {
        self.squares
            .iter()
            .any(|p| *p != EMPTY && color(*p) == side && !matches!(kind(*p), P | K))
    }

    fn clear_rook_castle(&mut self, sq: u8) {
        match sq {
            0 => self.castling &= !CASTLE_WQ,
            7 => self.castling &= !CASTLE_WK,
            56 => self.castling &= !CASTLE_BQ,
            63 => self.castling &= !CASTLE_BK,
            _ => {}
        }
    }

    fn in_check(&self, side: u8) -> bool {
        self.is_attacked(self.kings[side as usize], side ^ 1)
    }

    fn is_attacked(&self, sq: u8, by_side: u8) -> bool {
        let f = file_of(sq) as i8;
        let r = rank_of(sq) as i8;

        let pawn_rank = if by_side == WHITE { r - 1 } else { r + 1 };
        for df in [-1, 1] {
            let nf = f + df;
            if on_board(nf, pawn_rank)
                && self.squares[index(nf, pawn_rank) as usize] == piece(by_side, P)
            {
                return true;
            }
        }

        for (df, dr) in KNIGHT_STEPS {
            let nf = f + df;
            let nr = r + dr;
            if on_board(nf, nr) && self.squares[index(nf, nr) as usize] == piece(by_side, N) {
                return true;
            }
        }

        for (df, dr) in KING_STEPS {
            let nf = f + df;
            let nr = r + dr;
            if on_board(nf, nr) && self.squares[index(nf, nr) as usize] == piece(by_side, K) {
                return true;
            }
        }

        for (df, dr) in BISHOP_STEPS {
            if self.ray_attacked(f, r, df, dr, by_side, B) {
                return true;
            }
        }
        for (df, dr) in ROOK_STEPS {
            if self.ray_attacked(f, r, df, dr, by_side, R) {
                return true;
            }
        }
        false
    }

    fn ray_attacked(&self, f: i8, r: i8, df: i8, dr: i8, by_side: u8, slider: u8) -> bool {
        let mut nf = f + df;
        let mut nr = r + dr;
        while on_board(nf, nr) {
            let p = self.squares[index(nf, nr) as usize];
            if p != EMPTY {
                return color(p) == by_side && (kind(p) == slider || kind(p) == Q);
            }
            nf += df;
            nr += dr;
        }
        false
    }

    fn evaluate_white(&self) -> i32 {
        let mut mg = 0;
        let mut eg = 0;
        let mut phase = 0;
        for (sq, p) in self.squares.iter().enumerate() {
            if *p == EMPTY {
                continue;
            }
            let sign = if color(*p) == WHITE { 1 } else { -1 };
            let k = kind(*p);
            phase += phase_value(k);
            mg += sign * (piece_value(k) + pst_mg(k, color(*p), sq as u8));
            eg += sign * (piece_value(k) + pst_eg(k, color(*p), sq as u8));
        }
        let phase = phase.min(24);
        let mut score = (mg * phase + eg * (24 - phase)) / 24;
        score += self.classical_terms(WHITE) - self.classical_terms(BLACK_SIDE);
        self.scale_endgame(score)
    }

    fn classical_terms(&self, side: u8) -> i32 {
        self.bishop_pair_score(side)
            + self.pawn_structure_score(side)
            + self.king_safety_score(side)
            + self.mobility_score(side)
            + self.file_piece_score(side)
            + self.minor_piece_score(side)
            + self.space_center_score(side)
    }

    fn bishop_pair_score(&self, side: u8) -> i32 {
        if self.count_pieces(side, B) >= 2 {
            35
        } else {
            0
        }
    }

    fn pawn_structure_score(&self, side: u8) -> i32 {
        let friendly = self.pawn_files(side);
        let mut score = 0;
        for count in friendly {
            if count > 1 {
                score -= 12 * (count as i32 - 1);
            }
        }
        for sq in 0..64u8 {
            if self.squares[sq as usize] != piece(side, P) {
                continue;
            }
            let file = file_of(sq) as i32;
            let rel_rank = relative_rank(side, sq) as i32;
            let isolated = (file == 0 || friendly[(file - 1) as usize] == 0)
                && (file == 7 || friendly[(file + 1) as usize] == 0);
            if isolated {
                score -= 10;
            }
            if self.is_passed_pawn(side, sq) {
                score += 15 + rel_rank * 8;
                if self.protected_by_pawn(side, sq) {
                    score += 8;
                }
            }
            if self.has_adjacent_friendly_pawn(side, sq) {
                score += 4;
            }
        }
        score
    }

    fn king_safety_score(&self, side: u8) -> i32 {
        let king = self.kings[side as usize];
        let file = file_of(king) as i8;
        let rank = rank_of(king) as i8;
        let forward = if side == WHITE { 1 } else { -1 };
        let mut score = 0;
        for df in -1..=1 {
            let f = file + df;
            if !(0..8).contains(&f) {
                continue;
            }
            let one = rank + forward;
            let two = rank + forward * 2;
            if on_board(f, one) && self.squares[index(f, one) as usize] == piece(side, P) {
                score += 6;
            } else if on_board(f, two) && self.squares[index(f, two) as usize] == piece(side, P) {
                score += 3;
            } else {
                score -= 8;
            }
        }
        let files = self.pawn_files(side);
        if files[file as usize] == 0 {
            score -= 10;
        }
        score
    }

    fn mobility_score(&self, side: u8) -> i32 {
        let mut score = 0;
        for sq in 0..64u8 {
            let p = self.squares[sq as usize];
            if p == EMPTY || color(p) != side {
                continue;
            }
            let count = self.mobility_from(sq, p);
            score += match kind(p) {
                N => count * 4,
                B => count * 4,
                R => count * 2,
                Q => count,
                _ => 0,
            };
        }
        score
    }

    fn file_piece_score(&self, side: u8) -> i32 {
        let friendly_pawns = self.pawn_files(side);
        let enemy_pawns = self.pawn_files(side ^ 1);
        let mut score = 0;
        for sq in 0..64u8 {
            let p = self.squares[sq as usize];
            if p == EMPTY || color(p) != side {
                continue;
            }
            let k = kind(p);
            if k != R && k != Q {
                continue;
            }
            let file = file_of(sq) as usize;
            if friendly_pawns[file] == 0 && enemy_pawns[file] == 0 {
                score += if k == R { 12 } else { 6 };
            } else if friendly_pawns[file] == 0 {
                score += if k == R { 6 } else { 3 };
            }
            if k == R && relative_rank(side, sq) == 6 {
                score += 18;
            }
        }
        score
    }

    fn minor_piece_score(&self, side: u8) -> i32 {
        let mut score = 0;
        for sq in 0..64u8 {
            let p = self.squares[sq as usize];
            if p == EMPTY || color(p) != side {
                continue;
            }
            if kind(p) == N
                && relative_rank(side, sq) >= 3
                && self.protected_by_pawn(side, sq)
                && !self.pawn_attacks_square(side ^ 1, sq)
            {
                score += 18;
            }
            if kind(p) == B {
                score -= self.same_color_blocking_pawns(side, sq) * 2;
            }
        }
        score
    }

    fn space_center_score(&self, side: u8) -> i32 {
        let mut score = 0;
        for sq in [27u8, 28, 35, 36] {
            let p = self.squares[sq as usize];
            if p != EMPTY && color(p) == side {
                score += 6;
            }
            if self.is_attacked(sq, side) {
                score += 3;
            }
        }
        for sq in 0..64u8 {
            if self.squares[sq as usize] == piece(side, P) && relative_rank(side, sq) >= 4 {
                score += 2;
            }
        }
        score
    }

    fn evaluate_stm(&self) -> i32 {
        let white = self.evaluate_search_white();
        if self.side == WHITE {
            white + 10
        } else {
            -white + 10
        }
    }

    fn evaluate_search_white(&self) -> i32 {
        let mut mg = 0;
        let mut eg = 0;
        let mut phase = 0;
        for (sq, p) in self.squares.iter().enumerate() {
            if *p == EMPTY {
                continue;
            }
            let sign = if color(*p) == WHITE { 1 } else { -1 };
            let k = kind(*p);
            phase += phase_value(k);
            mg += sign * (piece_value(k) + pst_mg(k, color(*p), sq as u8));
            eg += sign * (piece_value(k) + pst_eg(k, color(*p), sq as u8));
        }
        let phase = phase.min(24);
        let mut score = (mg * phase + eg * (24 - phase)) / 24;
        score += self.bishop_pair_score(WHITE) - self.bishop_pair_score(BLACK_SIDE);
        self.scale_endgame(score)
    }

    fn pawn_files(&self, side: u8) -> [u8; 8] {
        let mut files = [0u8; 8];
        for sq in 0..64u8 {
            if self.squares[sq as usize] == piece(side, P) {
                files[file_of(sq) as usize] += 1;
            }
        }
        files
    }

    fn count_pieces(&self, side: u8, piece_kind: u8) -> u8 {
        self.squares
            .iter()
            .filter(|p| **p != EMPTY && color(**p) == side && kind(**p) == piece_kind)
            .count() as u8
    }

    fn is_passed_pawn(&self, side: u8, sq: u8) -> bool {
        let file = file_of(sq) as i8;
        let rank = rank_of(sq) as i8;
        let step = if side == WHITE { 1 } else { -1 };
        for df in -1..=1 {
            let f = file + df;
            if !(0..8).contains(&f) {
                continue;
            }
            let mut r = rank + step;
            while (0..8).contains(&r) {
                if self.squares[index(f, r) as usize] == piece(side ^ 1, P) {
                    return false;
                }
                r += step;
            }
        }
        true
    }

    fn protected_by_pawn(&self, side: u8, sq: u8) -> bool {
        let file = file_of(sq) as i8;
        let rank = rank_of(sq) as i8;
        let pawn_rank = if side == WHITE { rank - 1 } else { rank + 1 };
        for df in [-1, 1] {
            let f = file + df;
            if on_board(f, pawn_rank)
                && self.squares[index(f, pawn_rank) as usize] == piece(side, P)
            {
                return true;
            }
        }
        false
    }

    fn has_adjacent_friendly_pawn(&self, side: u8, sq: u8) -> bool {
        let file = file_of(sq) as i8;
        let rank = rank_of(sq) as i8;
        for df in [-1, 1] {
            let f = file + df;
            if !(0..8).contains(&f) {
                continue;
            }
            for dr in -1..=1 {
                let r = rank + dr;
                if on_board(f, r) && self.squares[index(f, r) as usize] == piece(side, P) {
                    return true;
                }
            }
        }
        false
    }

    fn pawn_attacks_square(&self, side: u8, sq: u8) -> bool {
        let file = file_of(sq) as i8;
        let rank = rank_of(sq) as i8;
        let pawn_rank = if side == WHITE { rank - 1 } else { rank + 1 };
        for df in [-1, 1] {
            let f = file + df;
            if on_board(f, pawn_rank)
                && self.squares[index(f, pawn_rank) as usize] == piece(side, P)
            {
                return true;
            }
        }
        false
    }

    fn same_color_blocking_pawns(&self, side: u8, bishop_sq: u8) -> i32 {
        let bishop_color = (file_of(bishop_sq) + rank_of(bishop_sq)) & 1;
        let mut count = 0;
        for sq in 0..64u8 {
            if self.squares[sq as usize] == piece(side, P)
                && ((file_of(sq) + rank_of(sq)) & 1) == bishop_color
            {
                count += 1;
            }
        }
        count
    }

    fn mobility_from(&self, sq: u8, piece_value_: u8) -> i32 {
        match kind(piece_value_) {
            N => count_step_mobility(self, sq, piece_value_, &KNIGHT_STEPS),
            B => count_slider_mobility(self, sq, piece_value_, &BISHOP_STEPS),
            R => count_slider_mobility(self, sq, piece_value_, &ROOK_STEPS),
            Q => count_slider_mobility(self, sq, piece_value_, &QUEEN_STEPS),
            _ => 0,
        }
    }

    fn scale_endgame(&self, score: i32) -> i32 {
        let mut white_bishop = None;
        let mut black_bishop = None;
        let mut other_non_king_pieces = 0;
        for sq in 0..64u8 {
            let p = self.squares[sq as usize];
            if p == EMPTY || kind(p) == K || kind(p) == P {
                continue;
            }
            if kind(p) == B {
                if color(p) == WHITE {
                    white_bishop = Some((file_of(sq) + rank_of(sq)) & 1);
                } else {
                    black_bishop = Some((file_of(sq) + rank_of(sq)) & 1);
                }
            } else {
                other_non_king_pieces += 1;
            }
        }
        if other_non_king_pieces == 0
            && self.count_pieces(WHITE, B) == 1
            && self.count_pieces(BLACK_SIDE, B) == 1
            && white_bishop != black_bishop
        {
            score * 2 / 3
        } else {
            score
        }
    }

    fn zobrist_key(&self) -> u64 {
        let mut key = 0u64;
        for sq in 0..64usize {
            let p = self.squares[sq];
            if p == EMPTY {
                continue;
            }
            let piece_idx = piece_hash_index(p) as u64;
            key ^= random64(piece_idx * 64 + sq as u64 + 1);
        }
        if self.side == BLACK_SIDE {
            key ^= random64(10_000);
        }
        if (self.castling & CASTLE_WK) != 0 {
            key ^= random64(20_000);
        }
        if (self.castling & CASTLE_WQ) != 0 {
            key ^= random64(20_001);
        }
        if (self.castling & CASTLE_BK) != 0 {
            key ^= random64(20_002);
        }
        if (self.castling & CASTLE_BQ) != 0 {
            key ^= random64(20_003);
        }
        if self.ep >= 0 {
            key ^= random64(30_000 + file_of(self.ep as u8) as u64);
        }
        key
    }
}

const KNIGHT_STEPS: [(i8, i8); 8] = [
    (1, 2),
    (2, 1),
    (2, -1),
    (1, -2),
    (-1, -2),
    (-2, -1),
    (-2, 1),
    (-1, 2),
];
const KING_STEPS: [(i8, i8); 8] = [
    (1, 1),
    (1, 0),
    (1, -1),
    (0, 1),
    (0, -1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
];
const BISHOP_STEPS: [(i8, i8); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];
const ROOK_STEPS: [(i8, i8); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
const QUEEN_STEPS: [(i8, i8); 8] = [
    (1, 1),
    (1, -1),
    (-1, 1),
    (-1, -1),
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
];

fn perft(board: Board, depth: u8) -> u64 {
    if depth == 0 {
        return 1;
    }
    let mut moves = MoveList::new();
    board.legal_moves(&mut moves);
    if depth == 1 {
        return moves.len as u64;
    }
    let mut nodes = 0;
    for mv in moves.as_slice() {
        let mut child = board;
        child.make_move(*mv);
        nodes += perft(child, depth - 1);
    }
    nodes
}

fn search(board: Board, depth: u8, max_time_ms: Option<u64>) -> SearchResult {
    search_with_limits(board, depth, max_time_ms, None, &[], DEFAULT_HASH_MB, 1)
}

fn search_with_limits(
    board: Board,
    depth: u8,
    max_time_ms: Option<u64>,
    max_nodes: Option<u64>,
    search_moves: &[String],
    hash_mb: usize,
    multi_pv: usize,
) -> SearchResult {
    search_with_stop(
        board,
        depth,
        max_time_ms,
        max_nodes,
        search_moves,
        hash_mb,
        multi_pv,
        None,
    )
}

fn search_with_stop(
    board: Board,
    depth: u8,
    max_time_ms: Option<u64>,
    max_nodes: Option<u64>,
    search_moves: &[String],
    hash_mb: usize,
    multi_pv: usize,
    stop: Option<Arc<AtomicBool>>,
) -> SearchResult {
    let mut state = SearchState::new(max_time_ms, max_nodes, hash_mb, stop);
    let mut best_move = None;
    let mut best_score = board.evaluate_stm();
    let mut completed_depth = 0;
    let mut pv = Vec::new();
    let mut multi_pv_lines = Vec::new();

    for current_depth in 1..=depth {
        let window = if completed_depth > 0 { 50 } else { INF };
        let alpha = if completed_depth > 0 {
            (best_score - window).max(-INF)
        } else {
            -INF
        };
        let beta = if completed_depth > 0 {
            (best_score + window).min(INF)
        } else {
            INF
        };
        let mut root = search_root_depth(
            board,
            current_depth,
            alpha,
            beta,
            search_moves,
            &mut state,
            multi_pv,
            best_move,
        );
        if !state.aborted && completed_depth > 0 && (root.score <= alpha || root.score >= beta) {
            root = search_root_depth(
                board,
                current_depth,
                -INF,
                INF,
                search_moves,
                &mut state,
                multi_pv,
                best_move,
            );
        }
        if root.no_legal_moves {
            best_score = if board.in_check(board.side) { -MATE } else { 0 };
            break;
        }
        if state.aborted {
            break;
        }
        completed_depth = current_depth;
        best_move = root.best_move;
        best_score = root.score;
        multi_pv_lines = root.lines;
        let root_key = board.zobrist_key();
        if let Some(mv) = best_move {
            state.tt.store(
                root_key,
                current_depth as i32,
                best_score,
                Bound::Exact,
                Some(mv),
            );
        }
        pv = multi_pv_lines
            .first()
            .map(|line| line.pv.clone())
            .unwrap_or_else(|| extract_pv(board, current_depth, &state.tt));
        if pv.is_empty() {
            if let Some(mv) = best_move {
                pv.push(mv);
            }
        }
        if best_score.abs() > MATE - 1000 {
            break;
        }
    }

    let elapsed_ms = state.started.elapsed().as_millis().max(1);
    let nps = ((state.nodes as u128 * 1000) / elapsed_ms) as u64;
    SearchResult {
        best_move,
        score_cp: best_score,
        pv,
        multi_pv: multi_pv_lines,
        depth: completed_depth,
        seldepth: state.seldepth,
        nodes: state.nodes,
        hashfull: state.tt.hashfull(),
        elapsed_ms,
        nps,
        aborted: state.aborted,
        abort_reason: state.abort_reason,
    }
}

struct RootSearchOutcome {
    no_legal_moves: bool,
    best_move: Option<Move>,
    score: i32,
    lines: Vec<PvLine>,
}

fn search_root_depth(
    board: Board,
    current_depth: u8,
    mut alpha: i32,
    beta: i32,
    search_moves: &[String],
    state: &mut SearchState,
    multi_pv: usize,
    previous_best: Option<Move>,
) -> RootSearchOutcome {
    let mut moves = MoveList::new();
    board.legal_moves(&mut moves);
    filter_search_moves(&mut moves, search_moves);
    let root_key = board.zobrist_key();
    let tt_move = state.tt.probe(root_key).and_then(|entry| entry.best_move);
    order_moves(&board, &mut moves, tt_move, Some(state), 0, None);
    if moves.len == 0 {
        return RootSearchOutcome {
            no_legal_moves: true,
            best_move: None,
            score: if board.in_check(board.side) { -MATE } else { 0 },
            lines: Vec::new(),
        };
    }

    let mut best_move = previous_best;
    let mut best_score = -INF;
    let mut lines = Vec::new();
    for mv in moves.as_slice() {
        let mut child = board;
        child.make_move(*mv);
        let score = -negamax(
            child,
            current_depth as i32 - 1,
            -beta,
            -alpha,
            1,
            state,
            Some(*mv),
            Some(mv.to),
        );
        if state.aborted {
            break;
        }
        let mut line_pv = vec![*mv];
        line_pv.extend(extract_pv(
            child,
            current_depth.saturating_sub(1),
            &state.tt,
        ));
        lines.push(PvLine {
            root: *mv,
            score_cp: score,
            pv: line_pv,
        });
        if score > best_score {
            best_score = score;
            best_move = Some(*mv);
        }
        if score > alpha {
            alpha = score;
        }
    }
    lines.sort_by(|a, b| b.score_cp.cmp(&a.score_cp));
    lines.truncate(multi_pv.max(1));
    RootSearchOutcome {
        no_legal_moves: false,
        best_move,
        score: best_score,
        lines,
    }
}

fn negamax(
    board: Board,
    depth: i32,
    mut alpha: i32,
    mut beta: i32,
    ply: i32,
    state: &mut SearchState,
    previous_move: Option<Move>,
    last_move_to: Option<u8>,
) -> i32 {
    if state.should_stop() {
        return board.evaluate_stm();
    }
    state.nodes += 1;
    state.seldepth = state.seldepth.max(ply as u8);

    if depth <= 0 {
        return quiesce(board, alpha, beta, ply, state);
    }

    let alpha_orig = alpha;
    let key = board.zobrist_key();
    let tt_entry = state.tt.probe(key);
    if let Some(entry) = tt_entry {
        if entry.depth >= depth {
            let tt_score = score_from_tt(entry.score, ply);
            match entry.bound {
                Bound::Exact => return tt_score,
                Bound::Lower => alpha = alpha.max(tt_score),
                Bound::Upper => beta = beta.min(tt_score),
            }
            if alpha >= beta {
                return tt_score;
            }
        }
    }

    let in_check = board.in_check(board.side);
    let static_eval = board.evaluate_stm();
    if !in_check && depth <= 2 && static_eval - 120 * depth >= beta {
        return static_eval;
    }
    if !in_check && depth >= 3 && board.has_non_pawn_material(board.side) {
        let null_score = -negamax(
            board.null_move(),
            depth - 3,
            -beta,
            -beta + 1,
            ply + 1,
            state,
            None,
            None,
        );
        if state.aborted {
            return null_score;
        }
        if null_score >= beta {
            return beta;
        }
    }

    let mut moves = MoveList::new();
    board.legal_moves(&mut moves);
    if moves.len == 0 {
        return if in_check { -MATE + ply } else { 0 };
    }
    order_moves(
        &board,
        &mut moves,
        tt_entry.and_then(|entry| entry.best_move),
        Some(state),
        ply as usize,
        previous_move,
    );

    let mut best = -INF;
    let mut best_move = None;
    let mut searched_moves = 0;
    for mv in moves.as_slice() {
        let tactical = is_tactical_move(&board, *mv);
        if !in_check && depth == 1 && !tactical && static_eval + 160 <= alpha {
            continue;
        }
        let mut child = board;
        child.make_move(*mv);
        let gives_check = child.in_check(child.side);
        let extension = if gives_check || last_move_to == Some(mv.to) {
            1
        } else {
            0
        };
        let child_depth = (depth - 1 + extension).max(0);
        let reduction =
            if searched_moves >= 4 && depth >= 3 && !tactical && !gives_check && extension == 0 {
                1
            } else {
                0
            };
        let mut score;
        if searched_moves == 0 {
            score = -negamax(
                child,
                child_depth,
                -beta,
                -alpha,
                ply + 1,
                state,
                Some(*mv),
                Some(mv.to),
            );
        } else {
            score = -negamax(
                child,
                (child_depth - reduction).max(0),
                -alpha - 1,
                -alpha,
                ply + 1,
                state,
                Some(*mv),
                Some(mv.to),
            );
            if !state.aborted && reduction > 0 && score > alpha {
                score = -negamax(
                    child,
                    child_depth,
                    -alpha - 1,
                    -alpha,
                    ply + 1,
                    state,
                    Some(*mv),
                    Some(mv.to),
                );
            }
            if !state.aborted && score > alpha && score < beta {
                score = -negamax(
                    child,
                    child_depth,
                    -beta,
                    -alpha,
                    ply + 1,
                    state,
                    Some(*mv),
                    Some(mv.to),
                );
            }
        }
        searched_moves += 1;
        if state.aborted {
            return if best > -INF { best } else { score };
        }
        if score > best {
            best = score;
            best_move = Some(*mv);
        }
        if best > alpha {
            alpha = best;
        }
        if alpha >= beta {
            if !tactical {
                remember_quiet_cutoff(state, *mv, depth, ply as usize, previous_move);
            }
            state
                .tt
                .store(key, depth, score_to_tt(best, ply), Bound::Lower, best_move);
            return best;
        }
    }
    if searched_moves == 0 {
        return static_eval;
    }
    if !state.aborted {
        let bound = if best > alpha_orig {
            Bound::Exact
        } else {
            Bound::Upper
        };
        state
            .tt
            .store(key, depth, score_to_tt(best, ply), bound, best_move);
    }
    best
}

fn quiesce(board: Board, mut alpha: i32, beta: i32, ply: i32, state: &mut SearchState) -> i32 {
    if state.should_stop() {
        return board.evaluate_stm();
    }
    state.nodes += 1;
    state.seldepth = state.seldepth.max(ply as u8);

    let in_check = board.in_check(board.side);
    if !in_check {
        let stand = board.evaluate_stm();
        if stand >= beta {
            return beta;
        }
        if stand > alpha {
            alpha = stand;
        }
        if ply >= 64 {
            return stand;
        }
    }

    let mut moves = MoveList::new();
    board.legal_moves(&mut moves);
    if moves.len == 0 {
        return if in_check { -MATE + ply } else { 0 };
    }
    if !in_check {
        retain_tactical_moves(&board, &mut moves);
    }
    order_moves(&board, &mut moves, None, None, 0, None);

    let mut best = if in_check { -MATE * 2 } else { alpha };
    for mv in moves.as_slice() {
        let mut child = board;
        child.make_move(*mv);
        let score = -quiesce(child, -beta, -alpha, ply + 1, state);
        if state.aborted {
            return best;
        }
        if score > best {
            best = score;
        }
        if best > alpha {
            alpha = best;
        }
        if alpha >= beta {
            break;
        }
    }
    best
}

fn extract_pv(mut board: Board, max_len: u8, tt: &TranspositionTable) -> Vec<Move> {
    let mut pv = Vec::new();
    let mut seen = Vec::new();
    for _ in 0..max_len {
        let key = board.zobrist_key();
        if seen.contains(&key) {
            break;
        }
        seen.push(key);
        let Some(entry) = tt.probe(key) else {
            break;
        };
        let Some(tt_move) = entry.best_move else {
            break;
        };
        let Some(mv) = find_matching_legal_move(&board, tt_move) else {
            break;
        };
        pv.push(mv);
        board.make_move(mv);
    }
    pv
}

fn find_matching_legal_move(board: &Board, wanted: Move) -> Option<Move> {
    let mut moves = MoveList::new();
    board.legal_moves(&mut moves);
    moves.as_slice().iter().copied().find(|mv| *mv == wanted)
}

fn score_to_tt(score: i32, ply: i32) -> i32 {
    if score > MATE - 1000 {
        score + ply
    } else if score < -MATE + 1000 {
        score - ply
    } else {
        score
    }
}

fn score_from_tt(score: i32, ply: i32) -> i32 {
    if score > MATE - 1000 {
        score - ply
    } else if score < -MATE + 1000 {
        score + ply
    } else {
        score
    }
}

fn retain_tactical_moves(board: &Board, moves: &mut MoveList) {
    let mut write = 0;
    for read in 0..moves.len {
        let mv = moves.moves[read];
        let target = if (mv.flags & FLAG_EP) != 0 {
            piece(color(board.squares[mv.from as usize]) ^ 1, P)
        } else {
            board.squares[mv.to as usize]
        };
        if target != EMPTY || mv.promo != 0 {
            moves.moves[write] = mv;
            write += 1;
        }
    }
    moves.len = write;
}

fn filter_search_moves(moves: &mut MoveList, search_moves: &[String]) {
    if search_moves.is_empty() {
        return;
    }
    let mut write = 0;
    for read in 0..moves.len {
        let mv = moves.moves[read];
        if search_moves.iter().any(|wanted| wanted == &move_to_uci(mv)) {
            moves.moves[write] = mv;
            write += 1;
        }
    }
    moves.len = write;
}

fn order_moves(
    board: &Board,
    moves: &mut MoveList,
    tt_move: Option<Move>,
    state: Option<&SearchState>,
    ply: usize,
    previous_move: Option<Move>,
) {
    moves.as_mut_slice().sort_by(|a, b| {
        move_score(board, b, tt_move, state, ply, previous_move).cmp(&move_score(
            board,
            a,
            tt_move,
            state,
            ply,
            previous_move,
        ))
    });
}

fn move_score(
    board: &Board,
    mv: &Move,
    tt_move: Option<Move>,
    state: Option<&SearchState>,
    ply: usize,
    previous_move: Option<Move>,
) -> i32 {
    if tt_move == Some(*mv) {
        return 1_000_000;
    }
    let moving = board.squares[mv.from as usize];
    let target = if (mv.flags & FLAG_EP) != 0 {
        piece(color(moving) ^ 1, P)
    } else {
        board.squares[mv.to as usize]
    };
    let mut score = 0;
    if target != EMPTY {
        score += 10_000 + piece_value(kind(target)) - piece_value(kind(moving)) / 10;
    }
    if mv.promo != 0 {
        score += 9_000 + piece_value(mv.promo);
    }
    if let Some(state) = state {
        if let Some(previous) = previous_move {
            if state.countermoves[history_index(previous)] == Some(*mv) {
                score += 8_000;
            }
        }
        if ply < MAX_SEARCH_PLY {
            let killers = state.killers[ply];
            if killers[0] == Some(*mv) {
                score += 7_000;
            } else if killers[1] == Some(*mv) {
                score += 6_900;
            }
        }
        score += state.history[history_index(*mv)].min(6_000);
    }
    score
}

fn is_tactical_move(board: &Board, mv: Move) -> bool {
    mv.promo != 0 || captured_piece(board, mv) != EMPTY
}

fn captured_piece(board: &Board, mv: Move) -> u8 {
    if (mv.flags & FLAG_EP) != 0 {
        piece(color(board.squares[mv.from as usize]) ^ 1, P)
    } else {
        board.squares[mv.to as usize]
    }
}

fn history_index(mv: Move) -> usize {
    mv.from as usize * 64 + mv.to as usize
}

fn remember_quiet_cutoff(
    state: &mut SearchState,
    mv: Move,
    depth: i32,
    ply: usize,
    previous_move: Option<Move>,
) {
    if ply < MAX_SEARCH_PLY {
        let killers = &mut state.killers[ply];
        if killers[0] != Some(mv) {
            killers[1] = killers[0];
            killers[0] = Some(mv);
        }
    }
    let idx = history_index(mv);
    state.history[idx] = state.history[idx].saturating_add(depth * depth);
    if let Some(previous) = previous_move {
        state.countermoves[history_index(previous)] = Some(mv);
    }
}

fn cmd_perft(args: &[String]) -> Result<(), String> {
    let fen = flag_value(args, "--fen").unwrap_or_else(|| START_FEN.to_string());
    let depth = flag_value(args, "--depth")
        .unwrap_or_else(|| "1".to_string())
        .parse::<u8>()
        .map_err(|_| "bad --depth".to_string())?;
    let board = Board::from_fen(&fen)?;
    let started = Instant::now();
    let nodes = perft(board, depth);
    let elapsed_ms = started.elapsed().as_millis().max(1);
    let nps = ((nodes as u128 * 1000) / elapsed_ms) as u64;
    println!(
        "{{\"kind\":\"perft\",\"fen\":\"{}\",\"depth\":{},\"nodes\":{},\"elapsedMs\":{},\"nps\":{}}}",
        json_escape(&fen),
        depth,
        nodes,
        elapsed_ms,
        nps
    );
    Ok(())
}

fn cmd_search(args: &[String]) -> Result<(), String> {
    let fen = flag_value(args, "--fen").unwrap_or_else(|| START_FEN.to_string());
    let depth = flag_value(args, "--depth")
        .unwrap_or_else(|| "4".to_string())
        .parse::<u8>()
        .map_err(|_| "bad --depth".to_string())?;
    let max_time_ms = flag_value(args, "--time").and_then(|v| v.parse::<u64>().ok());
    let max_nodes = flag_value(args, "--nodes").and_then(|v| v.parse::<u64>().ok());
    let hash_mb = flag_value(args, "--hash")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_HASH_MB);
    let multi_pv = flag_value(args, "--multipv")
        .or_else(|| flag_value(args, "--multi-pv"))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1);
    let search_moves = flag_values_after(args, "--searchmoves");
    let result = search_with_limits(
        Board::from_fen(&fen)?,
        depth,
        max_time_ms,
        max_nodes,
        &search_moves,
        hash_mb,
        multi_pv,
    );
    print_search_json("search", &fen, &result);
    Ok(())
}

fn cmd_eval(args: &[String]) -> Result<(), String> {
    let fen = flag_value(args, "--fen").unwrap_or_else(|| START_FEN.to_string());
    let board = Board::from_fen(&fen)?;
    let white = board.evaluate_white();
    let stm = if board.side == WHITE { white } else { -white };
    println!(
        "{{\"kind\":\"eval\",\"core\":\"rust\",\"fen\":\"{}\",\"scoreWhiteCp\":{},\"scoreCp\":{}}}",
        json_escape(&fen),
        white,
        stm
    );
    Ok(())
}

fn cmd_speed(args: &[String]) -> Result<(), String> {
    let depth = flag_value(args, "--depth")
        .unwrap_or_else(|| "4".to_string())
        .parse::<u8>()
        .map_err(|_| "bad --depth".to_string())?;
    let target_nps = flag_value(args, "--target-nps")
        .unwrap_or_else(|| "1000000".to_string())
        .parse::<u64>()
        .map_err(|_| "bad --target-nps".to_string())?;
    let max_time_ms = flag_value(args, "--time").and_then(|v| v.parse::<u64>().ok());

    let started = Instant::now();
    let mut total_nodes = 0u64;
    let mut rows = String::new();
    for (i, (name, fen)) in SPEED_CASES.iter().enumerate() {
        let result = search(Board::from_fen(fen)?, depth, max_time_ms);
        total_nodes += result.nodes;
        if i > 0 {
            rows.push(',');
        }
        rows.push_str(&format!(
            "{{\"name\":\"{}\",\"fen\":\"{}\",\"depth\":{},\"bestMove\":{},\"scoreCp\":{},\"nodes\":{},\"elapsedMs\":{},\"nps\":{},\"aborted\":{}}}",
            json_escape(name),
            json_escape(fen),
            result.depth,
            move_json(result.best_move),
            result.score_cp,
            result.nodes,
            result.elapsed_ms,
            result.nps,
            result.aborted
        ));
    }
    let elapsed_ms = started.elapsed().as_millis().max(1);
    let nps = ((total_nodes as u128 * 1000) / elapsed_ms) as u64;
    println!(
        "{{\"kind\":\"speed\",\"core\":\"rust\",\"targetNps\":{},\"passed\":{},\"positions\":{},\"depth\":{},\"totalNodes\":{},\"elapsedMs\":{},\"nps\":{},\"rows\":[{}]}}",
        target_nps,
        nps >= target_nps,
        SPEED_CASES.len(),
        depth,
        total_nodes,
        elapsed_ms,
        nps,
        rows
    );
    Ok(())
}

#[derive(Clone, Copy)]
struct UciConfig {
    default_depth: u8,
    hash_mb: usize,
    multi_pv: usize,
    move_overhead_ms: u64,
}

struct ActiveSearch {
    stop: Arc<AtomicBool>,
    handle: thread::JoinHandle<()>,
}

fn cmd_uci() -> Result<(), String> {
    let mut board = Board::from_fen(START_FEN)?;
    let mut config = UciConfig {
        default_depth: 4,
        hash_mb: DEFAULT_HASH_MB,
        multi_pv: 1,
        move_overhead_ms: 50,
    };
    let mut active: Option<ActiveSearch> = None;
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        if active
            .as_ref()
            .is_some_and(|search| search.handle.is_finished())
        {
            if let Some(search) = active.take() {
                let _ = search.handle.join();
            }
        }
        let line = line.map_err(|e| e.to_string())?;
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.is_empty() {
            continue;
        }
        match tokens[0] {
            "uci" => {
                println!("id name Chess Vision Studio Rust Classical Core");
                println!("id author Chess Vision Studio");
                println!("option name Default Depth type spin default 4 min 1 max 64");
                println!(
                    "option name Hash type spin default {} min 1 max 1024",
                    DEFAULT_HASH_MB
                );
                println!("option name MultiPV type spin default 1 min 1 max 16");
                println!("option name Move Overhead type spin default 50 min 0 max 5000");
                println!("option name Threads type spin default 1 min 1 max 1");
                println!("option name Clear Hash type button");
                println!("uciok");
            }
            "isready" => println!("readyok"),
            "ucinewgame" => board = Board::from_fen(START_FEN)?,
            "setoption" => apply_setoption(&mut config, &tokens),
            "position" => {
                board = parse_uci_position(&tokens)?;
            }
            "go" => {
                stop_active_search(&mut active);
                active = Some(spawn_uci_search(board, config, &tokens));
            }
            "stop" => stop_active_search(&mut active),
            "ponderhit" => {}
            "quit" => {
                stop_active_search(&mut active);
                break;
            }
            _ => {}
        }
        io::stdout().flush().ok();
    }
    stop_active_search(&mut active);
    Ok(())
}

fn spawn_uci_search(board: Board, config: UciConfig, tokens: &[&str]) -> ActiveSearch {
    let depth = parse_go_depth(tokens)
        .or_else(|| parse_go_mate_depth(tokens))
        .unwrap_or_else(|| {
            if parse_go_movetime(tokens).is_some()
                || parse_go_time_budget(board.side, config, tokens).is_some()
                || tokens
                    .iter()
                    .any(|token| *token == "infinite" || *token == "ponder")
            {
                64
            } else {
                config.default_depth
            }
        });
    let movetime =
        parse_go_movetime(tokens).or_else(|| parse_go_time_budget(board.side, config, tokens));
    let nodes = parse_go_nodes(tokens);
    let search_moves = parse_go_searchmoves(tokens);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let handle = thread::spawn(move || {
        let result = search_with_stop(
            board,
            depth,
            movetime,
            nodes,
            &search_moves,
            config.hash_mb,
            config.multi_pv,
            Some(thread_stop),
        );
        print_uci_info(&result);
        println!(
            "bestmove {}",
            result
                .best_move
                .map(move_to_uci)
                .unwrap_or_else(|| "0000".to_string())
        );
        io::stdout().flush().ok();
    });
    ActiveSearch { stop, handle }
}

fn stop_active_search(active: &mut Option<ActiveSearch>) {
    if let Some(search) = active.take() {
        search.stop.store(true, Ordering::Relaxed);
        let _ = search.handle.join();
    }
}

fn print_uci_info(result: &SearchResult) {
    if result.multi_pv.len() > 1 {
        for (idx, line) in result.multi_pv.iter().enumerate() {
            println!(
                "info depth {} seldepth {} multipv {} time {} nodes {} nps {} hashfull {} score cp {} pv {}",
                result.depth,
                result.seldepth,
                idx + 1,
                result.elapsed_ms,
                result.nodes,
                result.nps,
                result.hashfull,
                line.score_cp,
                pv_to_text(&line.pv)
            );
        }
        return;
    }
    println!(
        "info depth {} seldepth {} multipv 1 time {} nodes {} nps {} hashfull {} score cp {} pv {}",
        result.depth,
        result.seldepth,
        result.elapsed_ms,
        result.nodes,
        result.nps,
        result.hashfull,
        result.score_cp,
        pv_to_text(&result.pv)
    );
}

fn apply_setoption(config: &mut UciConfig, tokens: &[&str]) {
    let Some(name_start) = tokens.iter().position(|token| *token == "name") else {
        return;
    };
    let value_start = tokens.iter().position(|token| *token == "value");
    let name_end = value_start.unwrap_or(tokens.len());
    let name = tokens[name_start + 1..name_end]
        .join(" ")
        .to_ascii_lowercase();
    let value = value_start
        .and_then(|idx| tokens.get(idx + 1..))
        .map(|parts| parts.join(" "))
        .unwrap_or_default();

    match name.as_str() {
        "default depth" => {
            if let Ok(depth) = value.parse::<u8>() {
                config.default_depth = depth.clamp(1, 64);
            }
        }
        "hash" => {
            if let Ok(hash_mb) = value.parse::<usize>() {
                config.hash_mb = hash_mb.clamp(1, 1024);
            }
        }
        "multipv" => {
            if let Ok(multi_pv) = value.parse::<usize>() {
                config.multi_pv = multi_pv.clamp(1, 16);
            }
        }
        "move overhead" => {
            if let Ok(overhead) = value.parse::<u64>() {
                config.move_overhead_ms = overhead.min(5000);
            }
        }
        "threads" => {}
        "clear hash" => {}
        _ => {}
    }
}

fn parse_uci_position(tokens: &[&str]) -> Result<Board, String> {
    let mut idx = 1;
    let mut board;
    if tokens.get(idx) == Some(&"startpos") {
        board = Board::from_fen(START_FEN)?;
        idx += 1;
    } else if tokens.get(idx) == Some(&"fen") {
        let fen_start = idx + 1;
        let moves_idx = tokens
            .iter()
            .position(|t| *t == "moves")
            .unwrap_or(tokens.len());
        board = Board::from_fen(&tokens[fen_start..moves_idx].join(" "))?;
        idx = moves_idx;
    } else {
        return Err("unsupported position command".to_string());
    }
    if tokens.get(idx) == Some(&"moves") {
        for text in &tokens[idx + 1..] {
            if let Some(mv) = find_uci_move(&board, text) {
                board.make_move(mv);
            }
        }
    }
    Ok(board)
}

fn find_uci_move(board: &Board, text: &str) -> Option<Move> {
    let mut moves = MoveList::new();
    board.legal_moves(&mut moves);
    moves
        .as_slice()
        .iter()
        .copied()
        .find(|mv| move_to_uci(*mv) == text)
}

fn parse_go_depth(tokens: &[&str]) -> Option<u8> {
    tokens
        .windows(2)
        .find(|w| w[0] == "depth")
        .and_then(|w| w[1].parse::<u8>().ok())
}

fn parse_go_mate_depth(tokens: &[&str]) -> Option<u8> {
    tokens
        .windows(2)
        .find(|w| w[0] == "mate")
        .and_then(|w| w[1].parse::<u8>().ok())
        .map(|mate| mate.saturating_mul(2).clamp(1, 64))
}

fn parse_go_movetime(tokens: &[&str]) -> Option<u64> {
    tokens
        .windows(2)
        .find(|w| w[0] == "movetime")
        .and_then(|w| w[1].parse::<u64>().ok())
}

fn parse_go_time_budget(side: u8, config: UciConfig, tokens: &[&str]) -> Option<u64> {
    let remaining = if side == WHITE {
        parse_go_u64(tokens, "wtime")
    } else {
        parse_go_u64(tokens, "btime")
    }?;
    let increment = if side == WHITE {
        parse_go_u64(tokens, "winc").unwrap_or(0)
    } else {
        parse_go_u64(tokens, "binc").unwrap_or(0)
    };
    let moves_to_go = parse_go_u64(tokens, "movestogo").unwrap_or(30).max(1);
    let base = remaining / moves_to_go;
    let inc_part = increment.saturating_mul(3) / 4;
    let raw = base.saturating_add(inc_part);
    if remaining <= config.move_overhead_ms {
        return Some(1);
    }
    Some(
        raw.saturating_sub(config.move_overhead_ms)
            .max(1)
            .min(remaining.saturating_sub(config.move_overhead_ms)),
    )
}

fn parse_go_nodes(tokens: &[&str]) -> Option<u64> {
    tokens
        .windows(2)
        .find(|w| w[0] == "nodes")
        .and_then(|w| w[1].parse::<u64>().ok())
}

fn parse_go_u64(tokens: &[&str], name: &str) -> Option<u64> {
    tokens
        .windows(2)
        .find(|w| w[0] == name)
        .and_then(|w| w[1].parse::<u64>().ok())
}

fn parse_go_searchmoves(tokens: &[&str]) -> Vec<String> {
    let Some(start) = tokens.iter().position(|t| *t == "searchmoves") else {
        return Vec::new();
    };
    tokens[start + 1..]
        .iter()
        .take_while(|token| !is_go_keyword(token))
        .map(|token| token.to_lowercase())
        .collect()
}

fn is_go_keyword(token: &str) -> bool {
    matches!(
        token,
        "depth"
            | "nodes"
            | "movetime"
            | "wtime"
            | "btime"
            | "winc"
            | "binc"
            | "movestogo"
            | "mate"
            | "infinite"
            | "ponder"
    )
}

fn print_search_json(kind_name: &str, fen: &str, result: &SearchResult) {
    let abort = result
        .abort_reason
        .map(|r| format!("\"{}\"", r))
        .unwrap_or_else(|| "null".to_string());
    let mate = mate_json(result.score_cp);
    println!(
        "{{\"kind\":\"{}\",\"core\":\"rust\",\"fen\":\"{}\",\"depth\":{},\"seldepth\":{},\"bestMove\":{},\"scoreCp\":{},\"mate\":{},\"pv\":{},\"multiPv\":{},\"nodes\":{},\"hashfull\":{},\"elapsedMs\":{},\"nps\":{},\"aborted\":{},\"abortReason\":{}}}",
        kind_name,
        json_escape(fen),
        result.depth,
        result.seldepth,
        move_json(result.best_move),
        result.score_cp,
        mate,
        pv_json(&result.pv),
        multi_pv_json(&result.multi_pv),
        result.nodes,
        result.hashfull,
        result.elapsed_ms,
        result.nps,
        result.aborted,
        abort
    );
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

fn flag_values_after(args: &[String], name: &str) -> Vec<String> {
    let Some(start) = args.iter().position(|arg| arg == name) else {
        return Vec::new();
    };
    args[start + 1..]
        .iter()
        .take_while(|arg| !arg.starts_with("--"))
        .map(|arg| arg.to_lowercase())
        .collect()
}

fn piece_from_fen(ch: char) -> Result<u8, String> {
    let side = if ch.is_ascii_uppercase() {
        WHITE
    } else {
        BLACK_SIDE
    };
    let k = match ch.to_ascii_lowercase() {
        'p' => P,
        'n' => N,
        'b' => B,
        'r' => R,
        'q' => Q,
        'k' => K,
        _ => return Err(format!("invalid FEN piece: {}", ch)),
    };
    Ok(piece(side, k))
}

fn piece(side: u8, k: u8) -> u8 {
    if side == BLACK_SIDE { BLACK | k } else { k }
}

fn color(piece: u8) -> u8 {
    if (piece & BLACK) != 0 {
        BLACK_SIDE
    } else {
        WHITE
    }
}

fn kind(piece: u8) -> u8 {
    piece & 7
}

fn piece_hash_index(piece: u8) -> u8 {
    color(piece) * 6 + kind(piece) - 1
}

fn random64(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9e3779b97f4a7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

fn piece_value(k: u8) -> i32 {
    match k {
        P => 100,
        N => 320,
        B => 330,
        R => 500,
        Q => 900,
        K => 0,
        _ => 0,
    }
}

fn phase_value(k: u8) -> i32 {
    match k {
        N | B => 1,
        R => 2,
        Q => 4,
        _ => 0,
    }
}

fn relative_rank(side: u8, sq: u8) -> u8 {
    if side == WHITE {
        rank_of(sq)
    } else {
        7 - rank_of(sq)
    }
}

fn pst_mg(k: u8, side: u8, sq: u8) -> i32 {
    let rank = relative_rank(side, sq) as i32;
    let file = file_of(sq) as i32;
    let center_file = 3 - (file - 3).abs();
    let center_rank = 3 - (rank - 3).abs();
    match k {
        P => rank * 8 + center_file * 2,
        N => (center_file + center_rank) * 8,
        B => (center_file + center_rank) * 5,
        R => rank * 2,
        Q => (center_file + center_rank) * 2,
        K => -((center_file + center_rank) * 3),
        _ => 0,
    }
}

fn pst_eg(k: u8, side: u8, sq: u8) -> i32 {
    let rank = relative_rank(side, sq) as i32;
    let file = file_of(sq) as i32;
    let center_file = 3 - (file - 3).abs();
    let center_rank = 3 - (rank - 3).abs();
    match k {
        P => rank * 12 + center_file,
        N => (center_file + center_rank) * 5,
        B => (center_file + center_rank) * 4,
        R => rank * 3,
        Q => center_file + center_rank,
        K => (center_file + center_rank) * 8,
        _ => 0,
    }
}

fn count_step_mobility(board: &Board, sq: u8, piece_value_: u8, steps: &[(i8, i8)]) -> i32 {
    let mut count = 0;
    let file = file_of(sq) as i8;
    let rank = rank_of(sq) as i8;
    for (df, dr) in steps {
        let f = file + df;
        let r = rank + dr;
        if !on_board(f, r) {
            continue;
        }
        let target = board.squares[index(f, r) as usize];
        if target == EMPTY || color(target) != color(piece_value_) {
            count += 1;
        }
    }
    count
}

fn count_slider_mobility(board: &Board, sq: u8, piece_value_: u8, steps: &[(i8, i8)]) -> i32 {
    let mut count = 0;
    let file = file_of(sq) as i8;
    let rank = rank_of(sq) as i8;
    for (df, dr) in steps {
        let mut f = file + df;
        let mut r = rank + dr;
        while on_board(f, r) {
            let target = board.squares[index(f, r) as usize];
            if target == EMPTY {
                count += 1;
            } else {
                if color(target) != color(piece_value_) {
                    count += 1;
                }
                break;
            }
            f += df;
            r += dr;
        }
    }
    count
}

fn file_of(sq: u8) -> u8 {
    sq & 7
}

fn rank_of(sq: u8) -> u8 {
    sq >> 3
}

fn on_board(file: i8, rank: i8) -> bool {
    (0..8).contains(&file) && (0..8).contains(&rank)
}

fn index(file: i8, rank: i8) -> u8 {
    (rank as u8) * 8 + file as u8
}

fn square_from_text(text: &str) -> Option<u8> {
    let bytes = text.as_bytes();
    if bytes.len() != 2 || !(b'a'..=b'h').contains(&bytes[0]) || !(b'1'..=b'8').contains(&bytes[1])
    {
        return None;
    }
    Some((bytes[1] - b'1') * 8 + (bytes[0] - b'a'))
}

fn square_to_text(sq: u8) -> String {
    let file = (b'a' + file_of(sq)) as char;
    let rank = (b'1' + rank_of(sq)) as char;
    format!("{}{}", file, rank)
}

fn move_to_uci(mv: Move) -> String {
    let mut out = format!("{}{}", square_to_text(mv.from), square_to_text(mv.to));
    if mv.promo != 0 {
        out.push(match mv.promo {
            Q => 'q',
            R => 'r',
            B => 'b',
            N => 'n',
            _ => 'q',
        });
    }
    out
}

fn move_json(mv: Option<Move>) -> String {
    mv.map(|m| format!("\"{}\"", move_to_uci(m)))
        .unwrap_or_else(|| "null".to_string())
}

fn pv_to_text(pv: &[Move]) -> String {
    pv.iter()
        .map(|mv| move_to_uci(*mv))
        .collect::<Vec<_>>()
        .join(" ")
}

fn pv_json(pv: &[Move]) -> String {
    let moves = pv
        .iter()
        .map(|mv| format!("\"{}\"", move_to_uci(*mv)))
        .collect::<Vec<_>>();
    format!("[{}]", moves.join(","))
}

fn multi_pv_json(lines: &[PvLine]) -> String {
    let rows = lines
        .iter()
        .map(|line| {
            format!(
                "{{\"move\":\"{}\",\"scoreCp\":{},\"mate\":{},\"pv\":{}}}",
                move_to_uci(line.root),
                line.score_cp,
                mate_json(line.score_cp),
                pv_json(&line.pv)
            )
        })
        .collect::<Vec<_>>();
    format!("[{}]", rows.join(","))
}

fn mate_json(score: i32) -> String {
    if score.abs() <= MATE - 1000 {
        return "null".to_string();
    }
    let plies = MATE - score.abs();
    if score > 0 {
        plies.to_string()
    } else {
        format!("-{}", plies)
    }
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let result = match args.get(1).map(|s| s.as_str()) {
        Some("perft") => cmd_perft(&args[2..]),
        Some("eval") => cmd_eval(&args[2..]),
        Some("search") => cmd_search(&args[2..]),
        Some("speed") => cmd_speed(&args[2..]),
        Some("uci") => cmd_uci(),
        _ => {
            eprintln!(
                "usage: cvs-rust-core <perft|eval|search|speed|uci> [--fen FEN] [--depth N] [--time MS]"
            );
            Ok(())
        }
    };
    if let Err(error) = result {
        eprintln!("{}", error);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startpos_perft_matches_known_counts() {
        let board = Board::from_fen(START_FEN).unwrap();
        assert_eq!(perft(board, 1), 20);
        assert_eq!(perft(board, 2), 400);
        assert_eq!(perft(board, 3), 8902);
    }

    #[test]
    fn kiwipete_perft_matches_known_counts() {
        let board =
            Board::from_fen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
                .unwrap();
        assert_eq!(perft(board, 1), 48);
        assert_eq!(perft(board, 2), 2039);
        assert_eq!(perft(board, 3), 97862);
    }

    #[test]
    fn targeted_rules_are_legal() {
        assert_eq!(
            perft(
                Board::from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").unwrap(),
                1
            ),
            26
        );
        assert_eq!(
            perft(
                Board::from_fen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2").unwrap(),
                1
            ),
            7
        );
        assert_eq!(
            perft(
                Board::from_fen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1").unwrap(),
                1
            ),
            9
        );
        assert_eq!(
            perft(
                Board::from_fen("r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1").unwrap(),
                1
            ),
            23
        );
    }

    #[test]
    fn search_finds_hanging_queen() {
        let fen = "rnb1kbnr/pppp1ppp/8/3qp3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";
        let result = search(Board::from_fen(fen).unwrap(), 3, None);
        assert_eq!(result.best_move.map(move_to_uci).as_deref(), Some("e4d5"));
        assert!(result.nodes > 0);
    }

    #[test]
    fn search_populates_tt_pv() {
        let result = search_with_limits(
            Board::from_fen(START_FEN).unwrap(),
            3,
            None,
            None,
            &[],
            1,
            1,
        );
        assert!(result.pv.len() >= 2);
        assert!(result.seldepth >= result.depth);
    }

    #[test]
    fn search_returns_requested_multipv_lines() {
        let board = Board::from_fen(START_FEN).unwrap();
        let result = search_with_limits(board, 2, None, None, &[], 1, 3);
        let mut legal = MoveList::new();
        board.legal_moves(&mut legal);
        let legal_moves = legal
            .as_slice()
            .iter()
            .copied()
            .map(move_to_uci)
            .collect::<Vec<_>>();
        assert_eq!(result.multi_pv.len(), 3);
        assert_eq!(result.best_move, Some(result.multi_pv[0].root));
        assert!(
            result
                .multi_pv
                .iter()
                .all(|line| legal_moves.contains(&move_to_uci(line.root)))
        );
    }

    #[test]
    fn transposition_table_stores_and_probes_entries() {
        let board = Board::from_fen(START_FEN).unwrap();
        let key = board.zobrist_key();
        let mv = find_uci_move(&board, "e2e4").unwrap();
        let mut tt = TranspositionTable::new(1);
        tt.store(key, 4, 25, Bound::Exact, Some(mv));
        let entry = tt.probe(key).unwrap();
        assert_eq!(entry.depth, 4);
        assert_eq!(entry.score, 25);
        assert_eq!(entry.bound, Bound::Exact);
        assert_eq!(entry.best_move.map(move_to_uci).as_deref(), Some("e2e4"));
    }

    #[test]
    fn zobrist_key_tracks_position_state() {
        let start = Board::from_fen(START_FEN).unwrap();
        let mut after_move = start;
        after_move.make_move(find_uci_move(&after_move, "e2e4").unwrap());
        let no_castling =
            Board::from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1").unwrap();
        assert_ne!(start.zobrist_key(), after_move.zobrist_key());
        assert_ne!(start.zobrist_key(), no_castling.zobrist_key());
    }

    #[test]
    fn uci_time_controls_allocate_budget() {
        let config = UciConfig {
            default_depth: 4,
            hash_mb: 16,
            multi_pv: 1,
            move_overhead_ms: 50,
        };
        let tokens = [
            "go",
            "wtime",
            "30000",
            "btime",
            "30000",
            "winc",
            "1000",
            "movestogo",
            "30",
        ];
        assert_eq!(parse_go_time_budget(WHITE, config, &tokens), Some(1700));
        assert_eq!(parse_go_mate_depth(&["go", "mate", "3"]), Some(6));
    }

    #[test]
    fn cooperative_stop_sets_abort_reason() {
        let stop = Arc::new(AtomicBool::new(true));
        let result = search_with_stop(
            Board::from_fen(START_FEN).unwrap(),
            8,
            None,
            None,
            &[],
            1,
            1,
            Some(stop),
        );
        assert!(result.aborted);
        assert_eq!(result.abort_reason, Some("stop"));
    }

    #[test]
    fn null_move_changes_side_and_clears_ep() {
        let board = Board::from_fen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2").unwrap();
        let skipped = board.null_move();
        assert_eq!(skipped.side, BLACK_SIDE);
        assert_eq!(skipped.ep, -1);
    }

    #[test]
    fn quiet_cutoff_updates_ordering_tables() {
        let board = Board::from_fen(START_FEN).unwrap();
        let previous = find_uci_move(&board, "e2e4").unwrap();
        let response = find_uci_move(&board, "d2d4").unwrap();
        let mut state = SearchState::new(None, None, 1, None);
        remember_quiet_cutoff(&mut state, response, 3, 2, Some(previous));
        assert_eq!(state.killers[2][0], Some(response));
        assert!(state.history[history_index(response)] > 0);
        assert_eq!(state.countermoves[history_index(previous)], Some(response));
    }

    #[test]
    fn classical_eval_terms_reward_expected_features() {
        let bishop_pair = Board::from_fen("4k3/8/8/8/8/8/8/2B1K1B1 w - - 0 1").unwrap();
        let one_bishop = Board::from_fen("4k3/8/8/8/8/8/8/2B1K3 w - - 0 1").unwrap();
        assert!(bishop_pair.classical_terms(WHITE) > one_bishop.classical_terms(WHITE));

        let passer = Board::from_fen("4k3/8/4P3/8/8/8/8/4K3 w - - 0 1").unwrap();
        let blocked = Board::from_fen("4k3/4p3/4P3/8/8/8/8/4K3 w - - 0 1").unwrap();
        assert!(passer.pawn_structure_score(WHITE) > blocked.pawn_structure_score(WHITE));

        let open_file = Board::from_fen("4k3/8/8/8/8/8/8/R3K3 w - - 0 1").unwrap();
        let blocked_file = Board::from_fen("4k3/8/8/8/8/8/P7/R3K3 w - - 0 1").unwrap();
        assert!(open_file.file_piece_score(WHITE) > blocked_file.file_piece_score(WHITE));
    }

    #[test]
    fn opposite_bishop_endgames_are_scaled() {
        let opposite = Board::from_fen("2b1k3/8/8/8/8/8/P7/2B1K3 w - - 0 1").unwrap();
        let same = Board::from_fen("4k2b/8/8/8/8/8/P7/2B1K3 w - - 0 1").unwrap();
        assert_eq!(opposite.scale_endgame(300), 200);
        assert_eq!(same.scale_endgame(300), 300);
    }
}
