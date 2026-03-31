"""
backend/api/routes.py

Concurrency-safe API layer for Dots & Boxes.

Key production-oriented improvement:
  - Live game state is isolated per session_id instead of shared globally
  - Each session has its own lock, websocket group, and optional AI-vs-AI task
  - Database stats/history remain global across all sessions
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.ai.balance import FairnessController
from backend.ai.strategies import (
    AlphaBetaStrategy,
    DIFFICULTY_EASY,
    DIFFICULTY_EXPERT,
    DIFFICULTY_HARD,
    DIFFICULTY_MEDIUM,
    MinimaxStrategy,
    create_strategy,
    get_depth_for_difficulty,
)
from backend.database.db import get_game, get_win_stats, init_db, list_games, save_game
from backend.engine.game import GameState, GameStateError, InvalidMoveError
from backend.learning.qlearning import QLearner
from backend.session_manager import GameSession, SessionManager

router = APIRouter()

session_manager = SessionManager()
qlearner = QLearner()
fairness_ctrl = FairnessController()

_IS_VERCEL = bool(os.getenv("VERCEL"))
_AI_TIMEOUT_SECONDS = 6.0 if _IS_VERCEL else 10.0
_DEPTH_MAP = {
    1: DIFFICULTY_EASY,
    2: DIFFICULTY_MEDIUM,
    3: DIFFICULTY_HARD,
    4: DIFFICULTY_HARD,
    5: DIFFICULTY_EXPERT,
    6: DIFFICULTY_EXPERT,
    7: DIFFICULTY_EXPERT,
}


class StartGameReq(BaseModel):
    rows: int = 4
    cols: int = 4
    mode: str = "hvai"
    strategy: str = "alphabeta"
    difficulty: str = "hard"


class MoveReq(BaseModel):
    m_type: str
    r: int
    c: int


class AIMoveReq(BaseModel):
    strategy: str = "alphabeta"
    depth: int = 3
    difficulty: str = "hard"


class AiVsAiReq(BaseModel):
    strat1: str = "minimax"
    strat2: str = "alphabeta"
    depth: int = 3
    delay: float = Field(default=0.15, ge=0.01, le=1.0)
    rows: int = 4
    cols: int = 4


class CompareReq(BaseModel):
    depth: int = 3


async def _get_session(session_id: Optional[str]) -> GameSession:
    return await session_manager.get_or_create(session_id)


async def _cancel_aivai_task(session: GameSession) -> None:
    task = session.aivai_task
    if task and not task.done():
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=1.0)
        except Exception:
            pass
    session.aivai_task = None


async def push_state(session: GameSession) -> None:
    await session_manager.broadcast(
        session, {"type": "state", "data": session.game_state.get_state_dict()}
    )


async def push_metrics(session: GameSession, metrics: dict) -> None:
    await session_manager.broadcast(session, {"type": "metrics", "data": metrics})


async def push_event(session: GameSession, event_type: str, data: dict) -> None:
    await session_manager.broadcast(session, {"type": event_type, "data": data})


def _winner_for_state(state: GameState) -> int:
    s = state.scores
    p1, p2 = s.get(1, 0), s.get(2, 0)
    return 1 if p1 > p2 else (2 if p2 > p1 else 0)


def _effective_depth(state: GameState, requested_depth: int, difficulty: str) -> int:
    depth = max(1, min(int(requested_depth or get_depth_for_difficulty(difficulty)), 6))
    if not _IS_VERCEL:
        return depth

    remaining_moves = len(state.get_valid_moves())
    if remaining_moves >= 28:
        return min(depth, 2)
    if remaining_moves >= 16:
        return min(depth, 3)
    return min(depth, 4)


def _effective_aivai_depth(state: GameState, requested_depth: int) -> int:
    depth = max(1, min(int(requested_depth or 2), 4))
    remaining_moves = len(state.get_valid_moves())

    if _IS_VERCEL:
        if remaining_moves >= 28:
            return 1
        if remaining_moves >= 16:
            return min(depth, 2)
        if remaining_moves >= 8:
            return min(depth, 3)
        return min(depth, 4)

    if remaining_moves >= 28:
        return min(depth, 2)
    return depth


def _effective_aivai_delay(delay: float) -> float:
    if _IS_VERCEL:
        return max(0.01, min(delay, 0.05))
    return max(0.01, min(delay, 0.5))


async def _persist_finished_game(snapshot: dict) -> None:
    try:
        await save_game(
            mode=snapshot["mode"],
            strategy=snapshot["strategy"],
            rows=snapshot["rows"],
            cols=snapshot["cols"],
            winner=snapshot["winner"],
            score_p1=snapshot["score_p1"],
            score_p2=snapshot["score_p2"],
            moves_data=snapshot["moves"],
            started_at=snapshot["started_at"],
        )
    except Exception as e:
        print(f"[DB] Failed to save game for session {snapshot['session_id']}: {e}")

    try:
        await asyncio.to_thread(qlearner.save_data)
    except Exception as e:
        print(f"[Q] Failed to save Q-table: {e}")


async def _end_game(session: GameSession) -> None:
    meta = session.session_meta
    if meta.get("game_saved"):
        return
    meta["game_saved"] = True

    qlearner.increment_games()

    state = session.game_state
    p1 = state.scores.get(1, 0)
    p2 = state.scores.get(2, 0)
    winner = _winner_for_state(state)

    if meta.get("mode") == "aivai":
        fairness_ctrl.record_result(winner)

    await push_event(
        session,
        "game_over",
        {
            "scores": state.scores,
            "winner": winner,
            "balance": fairness_ctrl.get_stats(),
        },
    )

    snapshot = {
        "session_id": session.session_id,
        "mode": meta["mode"],
        "strategy": meta["strategy"],
        "rows": state.rows,
        "cols": state.cols,
        "winner": winner,
        "score_p1": p1,
        "score_p2": p2,
        "moves": [dict(move) for move in meta["moves"]],
        "started_at": meta["started_at"],
    }
    asyncio.create_task(_persist_finished_game(snapshot))


@router.websocket("/ws")
async def ws_endpoint(
    websocket: WebSocket,
    session_id: Optional[str] = Query(default=None),
):
    session = await _get_session(session_id)
    await websocket.accept()
    await session_manager.register_ws(session, websocket)
    try:
        await websocket.send_json({"type": "state", "data": session.game_state.get_state_dict()})
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, Exception):
        await session_manager.unregister_ws(session, websocket)


@router.get("/state")
async def get_state(session_id: Optional[str] = Query(default=None)):
    session = await _get_session(session_id)
    return session.game_state.get_state_dict()


@router.post("/start-game")
async def start_game(req: StartGameReq, session_id: Optional[str] = Query(default=None)):
    session = await _get_session(session_id)
    async with session.lock:
        await _cancel_aivai_task(session)
        rows = max(3, min(6, req.rows))
        cols = max(3, min(6, req.cols))
        session.game_state = GameState(rows=rows, cols=cols)
        session.reset_meta(req.mode, req.strategy, req.difficulty)
        await push_state(session)
        return {
            "status": "success",
            "rows": rows,
            "cols": cols,
            "mode": req.mode,
            "strategy": req.strategy,
            "difficulty": req.difficulty,
            "session_id": session.session_id,
            "state": session.game_state.get_state_dict(),
        }


@router.post("/reset")
async def reset_game(session_id: Optional[str] = Query(default=None)):
    session = await _get_session(session_id)
    async with session.lock:
        await _cancel_aivai_task(session)
        session.game_state = GameState(rows=session.game_state.rows, cols=session.game_state.cols)
        meta = session.session_meta
        meta["moves"] = []
        meta["move_num"] = 0
        meta["started_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        meta["game_saved"] = False
        await push_state(session)
        return {
            "status": "success",
            "session_id": session.session_id,
            "state": session.game_state.get_state_dict(),
        }


@router.post("/move")
async def human_move(move: MoveReq, session_id: Optional[str] = Query(default=None)):
    session = await _get_session(session_id)
    async with session.lock:
        state = session.game_state
        meta = session.session_meta
        if meta.get("mode") == "hvai" and state.current_player == 2:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "It is the AI's turn."},
            )
        try:
            dict_move = {"type": move.m_type, "r": move.r, "c": move.c}
            player_before = state.current_player
            state.apply_move(dict_move)
            meta["move_num"] += 1
            meta["moves"].append(
                {
                    "move_num": meta["move_num"],
                    "player": player_before,
                    "move_type": move.m_type,
                    "move_r": move.r,
                    "move_c": move.c,
                }
            )
            await push_state(session)
            if state.is_game_over:
                await _end_game(session)
            return {"status": "success", "state": state.get_state_dict()}
        except (InvalidMoveError, GameStateError) as e:
            return JSONResponse(status_code=400, content={"status": "error", "message": str(e)})
        except Exception as e:
            return JSONResponse(
                status_code=500,
                content={"status": "error", "message": f"Unexpected error: {e}"},
            )


@router.post("/ai-move")
async def ai_move(req: AIMoveReq, session_id: Optional[str] = Query(default=None)):
    session = await _get_session(session_id)
    async with session.lock:
        state = session.game_state
        meta = session.session_meta
        if state.is_game_over:
            return JSONResponse(status_code=400, content={"status": "error", "message": "Game over."})
        if not state.get_valid_moves():
            return JSONResponse(status_code=400, content={"status": "error", "message": "No valid moves."})

        difficulty = req.difficulty or _DEPTH_MAP.get(req.depth, DIFFICULTY_HARD)
        depth = _effective_depth(state, req.depth, difficulty)
        ai = create_strategy(req.strategy, difficulty, qlearner=qlearner)

        state_key_before = qlearner.get_state_key(state)
        player_before = state.current_player
        score_before = state.scores[player_before]
        state_clone = state.clone()

        try:
            best_move, _, metrics = await asyncio.wait_for(
                asyncio.to_thread(ai.compute_move, state_clone, depth),
                timeout=_AI_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            fallback = state.get_valid_moves()
            if not fallback:
                return JSONResponse(
                    status_code=400,
                    content={"status": "error", "message": "AI timed out, no moves."},
                )
            best_move = fallback[0]
            metrics = {"time": _AI_TIMEOUT_SECONDS, "nodes": 0, "pruned": 0}
        except Exception as e:
            return JSONResponse(status_code=500, content={"status": "error", "message": f"AI error: {e}"})

        if best_move is None:
            return JSONResponse(status_code=400, content={"status": "error", "message": "No moves available."})

        try:
            state.apply_move(best_move)
        except (InvalidMoveError, GameStateError) as e:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": f"AI produced illegal move: {e}"},
            )

        move_key = f"{best_move['type']}_{best_move['r']}_{best_move['c']}"
        boxes_gained = state.scores[player_before] - score_before
        opponent = 2 if player_before == 1 else 1
        if state.is_game_over:
            reward = (
                10.0
                if state.scores[player_before] > state.scores[opponent]
                else (-10.0 if state.scores[player_before] < state.scores[opponent] else 0.0)
            )
        else:
            reward = float(boxes_gained)

        state_key_after = qlearner.get_state_key(state)
        next_valid = state.get_valid_moves()
        qlearner.update_q_value(
            state_key_before,
            move_key,
            reward,
            state_key_after,
            next_valid,
            player=player_before,
        )
        q_val = qlearner.get_q_value(state_key_before, move_key, player=player_before)
        metrics["q_value"] = q_val
        metrics["strategy"] = req.strategy
        metrics["difficulty"] = difficulty

        meta["move_num"] += 1
        meta["moves"].append(
            {
                "move_num": meta["move_num"],
                "player": player_before,
                "move_type": best_move["type"],
                "move_r": best_move["r"],
                "move_c": best_move["c"],
                "nodes": metrics.get("nodes", 0),
                "pruned": metrics.get("pruned", 0),
                "exec_time": metrics.get("time", 0.0),
                "q_value": q_val,
                "strategy": req.strategy,
            }
        )

        await push_metrics(session, metrics)
        await push_state(session)
        if state.is_game_over:
            await _end_game(session)
        return {
            "status": "success",
            "move": best_move,
            "metrics": metrics,
            "state": state.get_state_dict(),
            "depth_used": depth,
        }


@router.post("/ai-vs-ai")
async def ai_vs_ai(req: AiVsAiReq, session_id: Optional[str] = Query(default=None)):
    session = await _get_session(session_id)
    async with session.lock:
        await _cancel_aivai_task(session)
        rows = max(3, min(6, req.rows))
        cols = max(3, min(6, req.cols))
        session.game_state = GameState(rows=rows, cols=cols)
        session.reset_meta("aivai", f"{req.strat1}_vs_{req.strat2}", "hard")
        await push_state(session)

        async def run() -> None:
            strategies = {
                1: create_strategy(req.strat1, DIFFICULTY_HARD, qlearner=qlearner),
                2: create_strategy(req.strat2, DIFFICULTY_HARD, qlearner=qlearner),
            }
            try:
                while True:
                    async with session.lock:
                        state = session.game_state
                        meta = session.session_meta
                        if state.is_game_over:
                            break

                        cur = state.current_player
                        ai = strategies[cur]
                        sk_b = qlearner.get_state_key(state)
                        sc_b = state.scores[cur]
                        state_clone = state.clone()

                    try:
                        search_depth = _effective_aivai_depth(state_clone, req.depth)
                        move, _, met = await asyncio.wait_for(
                            asyncio.to_thread(ai.compute_move, state_clone, search_depth),
                            timeout=_AI_TIMEOUT_SECONDS,
                        )
                    except asyncio.TimeoutError:
                        async with session.lock:
                            fallback = session.game_state.get_valid_moves()
                        if not fallback:
                            break
                        move = fallback[0]
                        met = {"time": _AI_TIMEOUT_SECONDS, "nodes": 0, "pruned": 0}

                    async with session.lock:
                        state = session.game_state
                        meta = session.session_meta
                        if state.is_game_over:
                            break
                        if move is None:
                            break
                        try:
                            state.apply_move(move)
                        except (InvalidMoveError, GameStateError):
                            break

                        bg = state.scores[cur] - sc_b
                        opp = 2 if cur == 1 else 1
                        if state.is_game_over:
                            rew = (
                                10.0
                                if state.scores[cur] > state.scores[opp]
                                else (-10.0 if state.scores[cur] < state.scores[opp] else 0.0)
                            )
                        else:
                            rew = float(bg)

                        sk_a = qlearner.get_state_key(state)
                        mk = f"{move['type']}_{move['r']}_{move['c']}"
                        qlearner.update_q_value(sk_b, mk, rew, sk_a, state.get_valid_moves(), player=cur)
                        q = qlearner.get_q_value(sk_b, mk, player=cur)

                        met["q_value"] = q
                        met["strategy"] = req.strat1 if cur == 1 else req.strat2

                        meta["move_num"] += 1
                        meta["moves"].append(
                            {
                                "move_num": meta["move_num"],
                                "player": cur,
                                "move_type": move["type"],
                                "move_r": move["r"],
                                "move_c": move["c"],
                                "nodes": met.get("nodes", 0),
                                "pruned": met.get("pruned", 0),
                                "exec_time": met.get("time", 0.0),
                                "q_value": q,
                                "strategy": met["strategy"],
                            }
                        )

                        await push_metrics(session, met)
                        await push_state(session)
                        game_over = state.is_game_over

                    if game_over:
                        break
                    await asyncio.sleep(_effective_aivai_delay(req.delay))
            except asyncio.CancelledError:
                pass
            except Exception as e:
                print(f"[AIvAI] unexpected crash in session {session.session_id}: {e}")
                await push_event(session, "error", {"message": f"AI vs AI error: {e}"})
            finally:
                async with session.lock:
                    if session.game_state.is_game_over:
                        await _end_game(session)
                    session.aivai_task = None

        session.aivai_task = asyncio.create_task(run())
        return {
            "status": "success",
            "message": "AI vs AI game running.",
            "grid": f"{rows}x{cols}",
            "session_id": session.session_id,
            "state": session.game_state.get_state_dict(),
        }


@router.get("/suggest")
async def suggest_move(
    depth: int = 3,
    session_id: Optional[str] = Query(default=None),
):
    session = await _get_session(session_id)
    async with session.lock:
        state = session.game_state
        if state.is_game_over:
            return {"status": "error", "message": "Game over."}
        if not state.get_valid_moves():
            return {"status": "error", "message": "No valid moves."}
        ai = AlphaBetaStrategy(time_limit=3.0)
        state_clone = state.clone()

    try:
        move, score, metrics = await asyncio.wait_for(
            asyncio.to_thread(ai.compute_move, state_clone, depth),
            timeout=5.0,
        )
    except asyncio.TimeoutError:
        async with session.lock:
            valid = session.game_state.get_valid_moves()
        move = valid[0] if valid else None
        score, metrics = 0.0, {"time": 5.0, "nodes": 0, "pruned": 0}

    return {"status": "success", "move": move, "score": score, "metrics": metrics}


@router.post("/comparison")
async def comparison(req: CompareReq, session_id: Optional[str] = Query(default=None)):
    session = await _get_session(session_id)
    async with session.lock:
        state = session.game_state
        if not state.get_valid_moves():
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "No moves available."},
            )
        state_clone_mm = state.clone()
        state_clone_ab = state.clone()

    mm = MinimaxStrategy()
    ab = AlphaBetaStrategy(time_limit=5.0)
    total_time_start = time.perf_counter()
    try:
        (
            (mm_move, mm_score, mm_met),
            (ab_move, ab_score, ab_met),
        ) = await asyncio.gather(
            asyncio.wait_for(
                asyncio.to_thread(mm.compute_move, state_clone_mm, req.depth),
                timeout=_AI_TIMEOUT_SECONDS,
            ),
            asyncio.wait_for(
                asyncio.to_thread(ab.compute_move, state_clone_ab, req.depth),
                timeout=_AI_TIMEOUT_SECONDS,
            ),
        )
    except asyncio.TimeoutError:
        return JSONResponse(status_code=408, content={"status": "error", "message": "Comparison timed out."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

    total_time = time.perf_counter() - total_time_start
    mm_time = mm_met.get("time", total_time)
    ab_time = ab_met.get("time", total_time)
    pruning_savings = 0.0
    if mm_met["nodes"] > 0:
        pruning_savings = round(100 * (1 - ab_met["nodes"] / max(mm_met["nodes"], 1)), 1)
    speedup = round(mm_time / max(ab_time, 1e-9), 2)

    return {
        "minimax": {
            "move": mm_move,
            "score": mm_score,
            "nodes": mm_met["nodes"],
            "time": round(mm_time, 4),
            "pruned": mm_met.get("pruned", 0),
        },
        "alphabeta": {
            "move": ab_move,
            "score": ab_score,
            "nodes": ab_met["nodes"],
            "time": round(ab_time, 4),
            "pruned": ab_met.get("pruned", 0),
        },
        "pruning_savings_pct": pruning_savings,
        "speedup_factor": speedup,
        "depth": req.depth,
    }


@router.get("/history")
async def history(limit: int = 50):
    try:
        games = await list_games(limit)
        return {"games": games}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@router.get("/history/{game_id}")
async def replay(game_id: int):
    try:
        data = await get_game(game_id)
        if not data:
            return JSONResponse(status_code=404, content={"status": "error", "message": "Game not found."})
        return data
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@router.get("/stats")
async def stats():
    try:
        db_stats = await get_win_stats()
        ql_stats = qlearner.get_stats()
        fc_stats = fairness_ctrl.get_stats()
        return {"database": db_stats, "learning": ql_stats, "balance": fc_stats}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@router.get("/balance-stats")
async def balance_stats():
    try:
        return {"status": "success", "balance": fairness_ctrl.get_stats()}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@router.get("/learning-stats")
async def learning_stats():
    try:
        return {"stats": qlearner.get_stats(), "top_moves": qlearner.export_top_moves(top_n=10)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})
